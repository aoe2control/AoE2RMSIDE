import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ArtifactVersionSchema,
  CompatibilityRangeSchema,
  CancellationRequestSchema,
  ConfigurationCatalogRequestSchema,
  ControlPipeExchangeRequestSchema,
  ControlPipeExchangeStatus as ProtocolControlPipeExchangeStatus,
  type ControlPipeExchangeResponse as ProtocolControlPipeExchangeResponse,
  ConstructVerificationStatus as ProtocolConstructVerificationStatus,
  type ConstructVerification as ProtocolConstructVerification,
  type ConnectionRoutes as ProtocolConnectionRoutes,
  DocumentIdentitySchema,
  EnvelopeSchema,
  ErrorCode,
  GenerationBackend,
  GenerationCertification as ProtocolGenerationCertification,
  GenerationEventKind,
  GenerationRequestSchema,
  GameMode,
  GameModeModifier,
  GameArtObjectSchema,
  GameArtPhase as ProtocolGameArtPhase,
  GameArtPrepareRequestSchema,
  GameArtSourceSchema,
  GameArtSpritesRequestSchema,
  GameArtStatus as ProtocolGameArtStatus,
  type GameArtResponse as ProtocolGameArtResponse,
  HandshakeRequestSchema,
  PositionPolicy,
  PlayerConfigurationSchema,
  PresentationStringIdsRequestSchema,
  PresentationStringIdsStatus,
  RequestIdentitySchema,
  SetupContextSchema,
  SourceCatalogEntrySchema,
  SourceCatalogOrigin,
  SourceCatalogRole,
  SourceCatalogRootsSchema,
  SourceCatalogSchema,
  ImplicitDefinitionSchema,
  ShutdownRequestSchema,
  StartingAge,
  StartingResourcePolicy,
  TraceLevel,
  InternalFixtureScenario,
  LocalContentImportRequestSchema,
  LocalContentImportStatus,
  LocalContentSourceSchema,
  MutationOperation,
  type Envelope,
  type ConfigurationCatalogResponse,
  type ContentPackDescriptor as ProtocolContentPackDescriptor,
  type LocalContentImportResponse,
  type GenerationResponse,
  type GenerationEvent as ProtocolGenerationEvent,
  type MinimapPaletteDescriptor as ProtocolMinimapPaletteDescriptor,
  ExecutionCostContext as ProtocolExecutionCostContext,
  ExecutionProgressKind,
  type ExecutionCostStep as ProtocolExecutionCostStep,
  type ExecutionCostSummary as ProtocolExecutionCostSummary,
  type ExecutionProgressEvent as ProtocolExecutionProgressEvent,
  VisualCheckpointStage,
  type VisualCheckpointEvent,
} from '../generated/rmside/v1/rmside_pb';
import {
  maximumPreviewCandidateChunks,
  previewCandidateContractMajor,
  validatePreviewCandidate,
  type PreviewCandidate,
  type PreviewCandidateStage,
} from '../shared/preview-candidate';
import {
  maximumExecutionGroups,
  maximumExecutionSteps,
  maximumStepCounters,
  parseExecutionCostSummary,
  validateExecutionProgressEvent,
  type ExecutionCostSummary,
  type ExecutionProgressEvent,
} from '../shared/execution-cost';
import type {
  ConfigurationCatalog,
  ContentPackDescriptor,
  DevelopmentFixtureDescriptor,
  GenerationCertification,
  NativeProcessStatus,
  PreviewGenerationEvent,
  PreviewGenerationInput,
  PreviewGenerationResult,
  TexturePaletteDescriptor,
} from '../shared/api';
import { encodeFrame, FrameDecoder } from './framing';
import * as latencyProbe from './latency-probe';
import type { MainWithin } from './latency-probe';
import type { LocalContentImportResult, LocalContentSource } from './local-content-service';
import type {
  GameArtNativeProgress,
  GameArtNativeResult,
  GameArtNativeSource,
} from './game-art-service';
import {
  decodeCliffPieceColumn,
  type GameArtPhase,
  type GameArtSpriteRequestObject,
} from '../shared/game-art';
import {
  isAscendingObjectIdList,
  mapIconArtObjectDescriptors,
} from '../shared/map-icon-art-objects';
import { decodeAppearanceObjectColumn } from '../shared/terrain-appearances';
import { constantNamesFor } from './constant-names-provider';
import {
  connectionRoutesFormatMajor,
  validateConnectionRoutes,
  type ConnectionRouteContext,
  type PreviewConnectionRoutesPayload,
} from '../shared/connection-routes';
import {
  type ConstructVerification,
  parseConstructVerification,
} from '../shared/construct-verification';
import { isTexturePaletteDescriptor } from '../shared/texture-palette';
import { guardChildStreams, isClosedPipeError } from './child-streams';
import { InstallationReadQueue } from './installation-read-queue';
import { editionCapabilities, rmsdRequestAllowed } from '../shared/edition';
import { DesktopError } from '../shared/desktop-error';
import { EditionFeatureUnavailableError } from './edition-ipc';
import type { PresentationStringIdsResult } from './local-presentation-names';
import type {
  ControlPipeExchangeInput,
  ControlPipeExchangeResult,
  ControlPipeExchangeStatus,
} from './control-node-host';
import type { TerrainMinimapIndices } from './local-presentation-palette';
import type {
  MainSourceCatalog,
  MainSourceCatalogOrigin,
  MainSourceCatalogRole,
} from './source-catalog-service';

interface PendingRequest {
  expectedCase: string;
  lastGenerationSequence?: number;
  onGenerationEvent?: (event: PreviewGenerationEvent) => void;
  onExecutionProgress?: (event: ExecutionProgressEvent) => void;
  onPreviewCandidate?: (candidate: PreviewCandidate) => void;
  onGameArtProgress?: (progress: GameArtNativeProgress) => void;
  onControlPipeChunk?: (data: Uint8Array) => void;
  resolve(message: Envelope): void;
  reject(error: Error): void;
}

const protocolVersion = { major: 2, minor: 19, patch: 0 } as const;

export class ProtocolResponseError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly protocolMessage: string,
    readonly retryable = false,
  ) {
    super(`${code}: ${protocolMessage}`);
    this.name = 'ProtocolResponseError';
  }
}

export function isInstallationReadersBusy(error: unknown): error is ProtocolResponseError {
  return (
    error instanceof ProtocolResponseError && error.code === ErrorCode.INTERNAL && error.retryable
  );
}

export function isProtocolCancellation(error: unknown): error is ProtocolResponseError {
  return error instanceof ProtocolResponseError && error.code === ErrorCode.CANCELLED;
}

export class RmsdClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private stopping = false;
  private presentationStringIds = false;
  private localContentImport = false;
  private progressivePreview = false;
  private gameArt = false;
  private connectionRoutes = false;
  private controlPipeExchangeSupported = false;
  private readonly installationReads = new InstallationReadQueue({
    isBusy: isInstallationReadersBusy,
  });

  constructor(
    private readonly executablePath: string,
    private readonly onStatus: (status: NativeProcessStatus) => void,
    private readonly requestAllowed: (kind: string) => boolean = (kind) =>
      rmsdRequestAllowed(kind, editionCapabilities),
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.onStatus({ name: 'rmsd', state: 'starting' });
    const child = spawn(this.executablePath, [], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.acceptOutput(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const detail = latencyProbe.nativeDiagnostics('rmsd', chunk).trim();
      if (detail && !this.stopping) this.onStatus({ name: 'rmsd', state: 'running', detail });
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
        `rmsd exited (code ${String(code)}, signal ${String(signal)})`,
        { name: 'rmsd' },
      );
      this.rejectPending(error);
      this.onStatus({
        name: 'rmsd',
        state: this.stopping ? 'stopped' : 'failed',
        detail: this.stopping ? undefined : error.message,
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const requestId = `handshake-${randomUUID()}`;
    const response = await this.sendAndWait(
      createEnvelope(requestId, {
        case: 'handshakeRequest',
        value: create(HandshakeRequestSchema, {
          protocolVersion: create(ArtifactVersionSchema, protocolVersion),
          supportedProtocol: create(CompatibilityRangeSchema, {
            minimumMajor: 2,
            maximumMajor: 2,
          }),
          clientName: 'aoe2-rmside-desktop',
        }),
      }),
      'handshakeResponse',
    );
    if (response.payload.case !== 'handshakeResponse') throw new Error('invalid rmsd handshake');
    const negotiated = response.payload.value;
    if (
      negotiated.protocolVersion?.major !== 2 ||
      negotiated.capabilities?.sourceCatalogV1 !== true
    ) {
      throw new Error('rmsd does not support the required source-catalog-v1 capability');
    }
    this.presentationStringIds = negotiated.capabilities.presentationStringIds;
    this.localContentImport = negotiated.capabilities.localContentImport;
    this.progressivePreview = negotiated.capabilities.progressivePreview;
    this.gameArt = negotiated.capabilities.gameArt;
    this.connectionRoutes = negotiated.capabilities.connectionRoutes;
    this.controlPipeExchangeSupported = negotiated.capabilities.controlPipeExchange;
    this.onStatus({ name: 'rmsd', state: 'running' });
  }

  async getConfigurationCatalog(): Promise<ConfigurationCatalog> {
    const requestId = `catalog-${randomUUID()}`;
    const response = await this.sendAndWait(
      createEnvelope(requestId, {
        case: 'configurationCatalogRequest',
        value: create(ConfigurationCatalogRequestSchema),
      }),
      'configurationCatalogResponse',
    );
    if (response.payload.case !== 'configurationCatalogResponse') {
      throw new Error('invalid configuration catalog response');
    }
    return toConfigurationCatalog(response.payload.value);
  }

  async readPresentationStringIds(datPath: string): Promise<PresentationStringIdsResult> {
    if (!this.presentationStringIds) {
      return {
        status: 'unreadable',
        objects: [],
        terrains: [],
        objectSlots: [],
        terrainSlotCount: 0,
        terrainMinimapIndices: [],
      };
    }
    const requestId = `presentation-ids-${randomUUID()}`;
    const response = await this.installationReads.run(() =>
      this.sendAndWait(
        createEnvelope(requestId, {
          case: 'presentationStringIdsRequest',
          value: create(PresentationStringIdsRequestSchema, { datPath }),
        }),
        'presentationStringIdsResponse',
      ),
    );
    if (response.payload.case !== 'presentationStringIdsResponse') {
      throw new Error('invalid presentation string identity response');
    }
    return toPresentationStringIds(response.payload.value);
  }

  async importLocalContent(source: LocalContentSource): Promise<LocalContentImportResult> {
    if (!this.localContentImport) {
      return { status: 'unsupported', message: 'rmsd does not derive local content' };
    }
    const requestId = `local-content-${randomUUID()}`;
    const response = await this.installationReads.run(() =>
      this.sendAndWait(
        createEnvelope(requestId, {
          case: 'localContentImportRequest',
          value: create(LocalContentImportRequestSchema, {
            source: protocolLocalContentSource(source),
          }),
        }),
        'localContentImportResponse',
      ),
    );
    if (response.payload.case !== 'localContentImportResponse') {
      throw new Error('invalid local content response');
    }
    return toLocalContentImportResult(response.payload.value);
  }

  async prepareGameArt(
    requestId: string,
    source: GameArtNativeSource,
    onProgress?: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult> {
    if (!this.gameArt) return unsupportedGameArt();
    return this.installationReads.run(
      async () =>
        toGameArtResult(
          await this.sendAndWaitWithGameArtProgress(
            createEnvelope(requestId, {
              case: 'gameArtPrepareRequest',
              value: create(GameArtPrepareRequestSchema, { source: protocolGameArtSource(source) }),
            }),
            onProgress,
          ),
        ),
      { id: requestId, cancelled: cancelledGameArt },
    );
  }

  async gameArtSprites(
    requestId: string,
    source: GameArtNativeSource,
    objects: readonly GameArtSpriteRequestObject[],
    onProgress?: (progress: GameArtNativeProgress) => void,
  ): Promise<GameArtNativeResult> {
    if (!this.gameArt) return unsupportedGameArt();
    const request = create(GameArtSpritesRequestSchema, {
      source: protocolGameArtSource(source),
      objects: objects.map((object) =>
        create(GameArtObjectSchema, {
          objectId: object.objectId,
          civilizationId: object.civilizationId,
        }),
      ),
    });
    return this.installationReads.run(
      async () =>
        toGameArtResult(
          await this.sendAndWaitWithGameArtProgress(
            createEnvelope(requestId, { case: 'gameArtSpritesRequest', value: request }),
            onProgress,
          ),
        ),
      { id: requestId, cancelled: cancelledGameArt },
    );
  }

  async controlPipeExchange(
    requestId: string,
    input: ControlPipeExchangeInput,
  ): Promise<ControlPipeExchangeResult> {
    if (!this.controlPipeExchangeSupported)
      return { status: 'unsupported', response: Buffer.alloc(0) };
    const chunks: Uint8Array[] = [];
    let received = 0;
    const response = await this.sendAndWait(
      createEnvelope(requestId, {
        case: 'controlPipeExchangeRequest',
        value: create(ControlPipeExchangeRequestSchema, {
          expectedServerProcessId: input.expectedServerProcessId,
          request: input.request,
          timeoutMilliseconds: input.timeoutMs,
          maximumResponseBytes: input.maximumResponseBytes,
        }),
      }),
      'controlPipeExchangeResponse',
      undefined,
      undefined,
      undefined,
      undefined,
      (data) => {
        received += data.byteLength;
        if (received <= input.maximumResponseBytes) chunks.push(data);
      },
    );
    if (response.payload.case !== 'controlPipeExchangeResponse') {
      throw new Error('invalid AoE2Control exchange response');
    }
    return toControlPipeExchangeResult(
      response.payload.value,
      chunks,
      received,
      input.maximumResponseBytes,
    );
  }

  private async sendAndWaitWithGameArtProgress(
    message: Envelope,
    onProgress?: (progress: GameArtNativeProgress) => void,
  ): Promise<ProtocolGameArtResponse> {
    const response = await this.sendAndWait(
      message,
      'gameArtResponse',
      undefined,
      undefined,
      undefined,
      onProgress,
    );
    if (response.payload.case !== 'gameArtResponse') throw new Error('invalid game art response');
    return response.payload.value;
  }

  async generatePreview(
    input: PreviewGenerationInput,
    sourceCatalog: MainSourceCatalog,
    onGenerationEvent?: (event: PreviewGenerationEvent) => void,
    internalFixtureId?: DevelopmentFixtureDescriptor['id'],
    localProductVersion = '',
    onExecutionProgress?: (event: ExecutionProgressEvent) => void,
    localContent?: LocalContentSource,
    onPreviewCandidate?: (candidate: PreviewCandidate) => void,
  ): Promise<PreviewGenerationResult> {
    const requestId = input.clientRequestId ?? `generation-${randomUUID()}`;
    const catalogEntry = sourceCatalog.sources.find(
      (candidate) =>
        candidate.normalizedPath === sourceCatalog.entryPath && candidate.role === 'rms-entry',
    );
    if (!catalogEntry || catalogEntry.sourceId !== input.documentUri) {
      throw new Error('source catalog entry differs from the requested document');
    }
    const source = Buffer.from(catalogEntry.source);
    const setup = decodeRendererSetupContext(input.modeContext, input.players.length);
    const generationEvents: PreviewGenerationEvent[] = [];
    const request = createEnvelope(requestId, {
      case: 'generationRequest',
      value: create(GenerationRequestSchema, {
        identity: create(RequestIdentitySchema, {
          requestId,
          documentRevision: BigInt(input.documentRevision),
        }),
        document: create(DocumentIdentitySchema, {
          uri: input.documentUri,
          revision: BigInt(input.documentRevision),
          sourceGraphHash: sourceCatalog.rmsGraphHash,
          sourceCatalogHash: sourceCatalog.catalogHash,
        }),
        profileId: input.profile.profileId,
        contentPackId: input.contentPack.packId,
        backend:
          input.backend === 'synthetic'
            ? GenerationBackend.SYNTHETIC_TEST
            : GenerationBackend.EXACT,
        width: input.width,
        height: input.height,
        seed: BigInt(input.seed),
        source,
        mapSize: input.mapSize,
        players: input.players.map((player, index) =>
          create(PlayerConfigurationSchema, {
            slot: player.slot,
            team: player.team,
            civilizationId: player.civilizationId,
            color: setup.colors[index],
          }),
        ),
        setupContext: protocolSetupContext(setup),
        traceLevel:
          input.traceLevel === 'off'
            ? TraceLevel.OFF
            : input.traceLevel === 'full'
              ? TraceLevel.FULL
              : TraceLevel.SUMMARY,
        behaviorProfileHash: fromHex(input.profile.profileHash, 'behavior profile hash'),
        contentPackVersion: input.contentPack.packVersion,
        contentPackHash: fromHex(input.contentPack.contentHash, 'content pack hash'),
        contentSourceFingerprint: input.contentPack.sourceFingerprint,
        sourceHash: createHash('sha256').update(source).digest(),
        internalFixtureScenario: internalFixtureScenario(internalFixtureId),
        sourceCatalog: protocolSourceCatalog(sourceCatalog),
        localProductVersion,
        executionProgress: onExecutionProgress !== undefined,
        ...(localContent ? { localContent: protocolLocalContentSource(localContent) } : {}),
        progressivePreview: onPreviewCandidate !== undefined && this.progressivePreview,
        connectionRoutes: this.connectionRoutes,
      }),
    });
    latencyProbe.step(requestId, 'request-build');
    const response = await this.sendAndWait(
      request,
      'generationResponse',
      (event) => {
        generationEvents.push(event);
        onGenerationEvent?.(event);
      },
      onExecutionProgress,
      onPreviewCandidate,
    );
    if (response.payload.case !== 'generationResponse')
      throw new Error('invalid generation response');
    const result = toPreviewResult(
      response.payload.value,
      input,
      sourceCatalog,
      generationEvents,
      setup.colors,
    );
    latencyProbe.step(requestId, 'response-convert');
    return result;
  }

  async cancelGeneration(clientRequestId: string): Promise<boolean> {
    if (this.installationReads.cancel(clientRequestId)) return true;
    const requestId = `cancellation-${randomUUID()}`;
    const response = await this.sendAndWait(
      createEnvelope(requestId, {
        case: 'cancellationRequest',
        value: create(CancellationRequestSchema, { requestId: clientRequestId }),
      }),
      'cancellationResponse',
    );
    return response.payload.case === 'cancellationResponse' && response.payload.value.accepted;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    try {
      const requestId = `shutdown-${randomUUID()}`;
      await Promise.race([
        this.sendAndWait(
          createEnvelope(requestId, {
            case: 'shutdownRequest',
            value: create(ShutdownRequestSchema),
          }),
          'shutdownResponse',
        ),
        timeout(1500, 'rmsd shutdown timed out'),
      ]);
    } catch {
      child.kill();
    } finally {
      child.stdin.end();
    }
    await waitForExit(child, 1500);
  }

  async forceTerminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill();
    await waitForExit(child, 500);
  }

  kill(): void {
    this.stopping = true;
    this.child?.kill();
  }

  private sendAndWait(
    message: Envelope,
    expectedCase: string,
    onGenerationEvent?: (event: PreviewGenerationEvent) => void,
    onExecutionProgress?: (event: ExecutionProgressEvent) => void,
    onPreviewCandidate?: (candidate: PreviewCandidate) => void,
    onGameArtProgress?: (progress: GameArtNativeProgress) => void,
    onControlPipeChunk?: (data: Uint8Array) => void,
  ): Promise<Envelope> {
    const kind = message.payload.case ?? '';
    if (!this.requestAllowed(kind)) {
      return Promise.reject(new EditionFeatureUnavailableError(`rmsd:${kind}`));
    }
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(
        new DesktopError('native.unavailable', 'rmsd is not running', { name: 'rmsd' }),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        expectedCase,
        onGenerationEvent,
        onExecutionProgress,
        onPreviewCandidate,
        onGameArtProgress,
        onControlPipeChunk,
        resolve,
        reject,
      });
      const frame = encodeFrame(toBinary(EnvelopeSchema, message));
      latencyProbe.step(message.requestId, 'request-encode');
      child.stdin.write(frame, (error) => {
        if (error) {
          this.pending.delete(message.requestId);
          reject(error);
        }
      });
    });
  }

  private acceptOutput(chunk: Buffer): void {
    try {
      let streamed: [string, MainWithin, number] | undefined;
      const settleStreamed = () => {
        if (!streamed) return;
        latencyProbe.within(streamed[0], streamed[1], latencyProbe.now() - streamed[2]);
        streamed = undefined;
      };
      for (const frame of this.decoder.push(chunk)) {
        settleStreamed();
        const decodeStarted = latencyProbe.now();
        const message = fromBinary(EnvelopeSchema, frame);
        const pending = this.pending.get(message.requestId);
        if (!pending || message.payload.case === 'progressEvent') continue;
        if (message.payload.case !== 'generationResponse' && message.payload.case !== 'error') {
          streamed = [
            message.requestId,
            message.payload.case === 'visualCheckpointEvent' ? 'candidate-frames' : 'event-frames',
            decodeStarted,
          ];
        } else {
          latencyProbe.stepUntil(message.requestId, 'child-wait', decodeStarted);
          latencyProbe.step(message.requestId, 'response-decode');
        }
        if (message.payload.case === 'executionProgressEvent') {
          const progress = toExecutionProgressEvent(message.payload.value, message.requestId);
          if (progress) pending.onExecutionProgress?.(progress);
          continue;
        }
        if (message.payload.case === 'gameArtProgressEvent') {
          const progress = toGameArtProgress(message.payload.value);
          if (progress) pending.onGameArtProgress?.(progress);
          continue;
        }
        if (message.payload.case === 'controlPipeResponseChunk') {
          pending.onControlPipeChunk?.(message.payload.value.data);
          continue;
        }
        if (message.payload.case === 'visualCheckpointEvent') {
          const candidate = pending.onPreviewCandidate
            ? toPreviewCandidate(message.payload.value, message.requestId)
            : undefined;
          if (candidate) pending.onPreviewCandidate?.(candidate);
          continue;
        }
        if (message.payload.case === 'generationEvent') {
          const event = toPreviewGenerationEvent(message.payload.value);
          if (event.requestId !== message.requestId) {
            throw new Error('rmsd generation event identity differs from its envelope');
          }
          if (
            pending.lastGenerationSequence !== undefined &&
            event.sequence <= pending.lastGenerationSequence
          ) {
            throw new Error('rmsd generation event sequence is not strictly ordered');
          }
          pending.lastGenerationSequence = event.sequence;
          pending.onGenerationEvent?.(event);
          continue;
        }
        this.pending.delete(message.requestId);
        if (message.payload.case === 'error') {
          pending.reject(
            new ProtocolResponseError(
              message.payload.value.code,
              message.payload.value.message,
              message.payload.value.retryable,
            ),
          );
        } else if (message.payload.case !== pending.expectedCase) {
          pending.reject(
            new Error(`expected ${pending.expectedCase}, received ${String(message.payload.case)}`),
          );
        } else {
          pending.resolve(message);
        }
      }
      settleStreamed();
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.onStatus({ name: 'rmsd', state: 'failed', detail: error.message });
    this.child?.kill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export interface DecodedRendererSetupContext {
  gameMode: GameMode;
  startingResources: StartingResourcePolicy;
  startingAge: StartingAge;
  positionPolicy: PositionPolicy;
  colors: number[];
  computerPlayerSlots: number[];
  gameModeModifiers: GameModeModifier[];
  turboMode: boolean;
  fullTechTree: boolean;
  antiquityMode: boolean;
  solidFarms: boolean;
}

const compactGameModeModifiers: Readonly<Record<string, GameModeModifier>> = {
  1: GameModeModifier.EMPIRE_WARS,
  2: GameModeModifier.SUDDEN_DEATH,
  3: GameModeModifier.REGICIDE,
  4: GameModeModifier.KING_OF_THE_HILL,
};
const compactLobbyFlags = {
  t: 'turboMode',
  ft: 'fullTechTree',
  aq: 'antiquityMode',
  sf: 'solidFarms',
} as const;
const requiredSetupFields = ['gm', 'r', 'a', 'p', 'c'] as const;
const optionalSetupFields = ['ai', 'm', ...Object.keys(compactLobbyFlags)];

export function decodeRendererSetupContext(
  value: string,
  playerCount: number,
): DecodedRendererSetupContext {
  if (!value.startsWith('aoe2:')) throw new Error('typed setup adapter requires aoe2 context v1');
  const fields = new Map<string, string>();
  for (const component of value.slice(5).split(';')) {
    const separator = component.indexOf('=');
    if (separator <= 0) throw new Error('typed setup adapter received a malformed field');
    const key = component.slice(0, separator);
    const fieldValue = component.slice(separator + 1);
    if (
      fields.has(key) ||
      (!(requiredSetupFields as readonly string[]).includes(key) &&
        !optionalSetupFields.includes(key))
    ) {
      throw new Error('typed setup adapter received duplicate or unknown fields');
    }
    fields.set(key, fieldValue);
  }
  if (requiredSetupFields.some((key) => !fields.has(key))) {
    throw new Error('typed setup adapter requires every setup field');
  }
  const computerPlayerSlots = fields.has('ai')
    ? (fields.get('ai') ?? '').split(',').map((entry) => {
        if (!/^[1-8]$/.test(entry)) throw new Error('typed setup computer slot is invalid');
        return Number(entry);
      })
    : [];
  if (
    computerPlayerSlots.some((slot, index) => index > 0 && slot <= computerPlayerSlots[index - 1]!)
  ) {
    throw new Error('typed setup computer slots must be unique and ascending');
  }
  const modifierValues = fields.has('m') ? (fields.get('m') ?? '').split(',') : [];
  const gameModeModifiers = modifierValues.map((entry) => {
    const modifier = /^[1-4]$/u.test(entry) ? compactGameModeModifiers[entry] : undefined;
    if (modifier === undefined) throw new Error('typed setup game mode modifier is invalid');
    return modifier;
  });
  if (
    gameModeModifiers.some((value, index) => index > 0 && value <= gameModeModifiers[index - 1]!)
  ) {
    throw new Error('typed setup game mode modifiers must be unique and in contract order');
  }
  const flags = Object.fromEntries(
    Object.entries(compactLobbyFlags).map(([key, name]) => {
      if (fields.has(key) && fields.get(key) !== '1') {
        throw new Error(`typed setup field ${key} is invalid`);
      }
      return [name, fields.has(key)];
    }),
  ) as Record<(typeof compactLobbyFlags)[keyof typeof compactLobbyFlags], boolean>;
  const integer = (key: string): number => {
    const raw = fields.get(key) ?? '';
    if (!/^\d+$/.test(raw)) throw new Error(`typed setup field ${key} is not an integer`);
    return Number(raw);
  };
  const mapValue = <T>(key: string, values: Readonly<Record<number, T>>): T => {
    const mapped = values[integer(key)];
    if (mapped === undefined) throw new Error(`typed setup field ${key} is unsupported`);
    return mapped;
  };
  const colors = (fields.get('c') ?? '').split(',').map((entry) => {
    if (!/^\d+$/.test(entry)) throw new Error('typed setup player color is not an integer');
    const color = Number(entry);
    if (color < 0 || color > 7) throw new Error('typed setup player color is out of range');
    return color;
  });
  if (colors.length !== playerCount) {
    throw new Error('typed setup player colors do not match the explicit player list');
  }
  return {
    gameMode: mapValue('gm', {
      0: GameMode.RANDOM_MAP,
      1: GameMode.REGICIDE,
      2: GameMode.DEATH_MATCH,
      5: GameMode.KING_OF_THE_HILL,
      6: GameMode.WONDER_RACE,
      7: GameMode.DEFEND_THE_WONDER,
      8: GameMode.TURBO_RANDOM_MAP,
      10: GameMode.CAPTURE_THE_RELIC,
      11: GameMode.SUDDEN_DEATH,
      12: GameMode.BATTLE_ROYALE,
      13: GameMode.EMPIRE_WARS,
    }),
    startingResources: mapValue('r', {
      0: StartingResourcePolicy.STANDARD,
      1: StartingResourcePolicy.LOW,
      2: StartingResourcePolicy.MEDIUM,
      3: StartingResourcePolicy.HIGH,
      4: StartingResourcePolicy.ULTRA_HIGH,
      5: StartingResourcePolicy.INFINITE,
      6: StartingResourcePolicy.RANDOM,
    }),
    startingAge: mapValue('a', {
      0: StartingAge.STANDARD,
      2: StartingAge.DARK_AGE,
      3: StartingAge.FEUDAL_AGE,
      4: StartingAge.CASTLE_AGE,
      5: StartingAge.IMPERIAL_AGE,
      6: StartingAge.POST_IMPERIAL_AGE,
    }),
    positionPolicy: mapValue('p', {
      0: PositionPolicy.RANDOM,
      1: PositionPolicy.FIXED,
      2: PositionPolicy.TEAM_TOGETHER,
    }),
    colors,
    computerPlayerSlots,
    gameModeModifiers,
    ...flags,
  };
}

export function protocolSetupContext(setup: DecodedRendererSetupContext) {
  const lobbyOptions =
    setup.gameModeModifiers.length > 0 ||
    setup.turboMode ||
    setup.fullTechTree ||
    setup.antiquityMode ||
    setup.solidFarms;
  return create(SetupContextSchema, {
    contractVersion: create(ArtifactVersionSchema, {
      major: 1,
      minor: lobbyOptions ? 2 : setup.computerPlayerSlots.length > 0 ? 1 : 0,
      patch: 0,
    }),
    gameMode: setup.gameMode,
    startingResources: setup.startingResources,
    startingAge: setup.startingAge,
    positionPolicy: setup.positionPolicy,
    computerPlayerSlots: setup.computerPlayerSlots,
    gameModeModifiers: setup.gameModeModifiers,
    turboMode: setup.turboMode,
    fullTechTree: setup.fullTechTree,
    antiquityMode: setup.antiquityMode,
    solidFarms: setup.solidFarms,
  });
}

export function toPresentationStringIds(response: {
  status: PresentationStringIdsStatus;
  objects: ReadonlyArray<{ id: number; stringId: number }>;
  terrains: ReadonlyArray<{ id: number; stringId: number }>;
  objectSlots?: ReadonlyArray<{ id: number; standingGraphic: boolean }>;
  terrainSlotCount?: number;
  terrainMinimapIndices?: ReadonlyArray<{
    id: number;
    highIndex: number;
    mediumIndex: number;
    lowIndex: number;
  }>;
}): PresentationStringIdsResult {
  const entries = (
    values: ReadonlyArray<{ id: number; stringId: number }>,
    maximumId: number,
  ): Array<{ id: number; stringId: number }> => {
    if (values.length > maximumId + 1)
      throw new Error('presentation string identities are invalid');
    return values.map((entry, index) => {
      if (
        !Number.isInteger(entry.id) ||
        entry.id > maximumId ||
        (index > 0 && values[index - 1]!.id >= entry.id) ||
        !Number.isInteger(entry.stringId) ||
        entry.stringId < 1 ||
        entry.stringId > 16_777_215
      ) {
        throw new Error('presentation string identities are invalid');
      }
      return { id: entry.id, stringId: entry.stringId };
    });
  };
  const slots = (
    values: ReadonlyArray<{ id: number; standingGraphic: boolean }>,
  ): Array<{ id: number; standingGraphic: boolean }> => {
    if (values.length > 65_536) throw new Error('presentation object slots are invalid');
    return values.map((entry, index) => {
      if (
        !Number.isInteger(entry.id) ||
        entry.id < 0 ||
        entry.id > 65_535 ||
        (index > 0 && values[index - 1]!.id >= entry.id) ||
        typeof entry.standingGraphic !== 'boolean'
      ) {
        throw new Error('presentation object slots are invalid');
      }
      return { id: entry.id, standingGraphic: entry.standingGraphic };
    });
  };
  const minimapIndices = (
    values: NonNullable<typeof response.terrainMinimapIndices>,
  ): TerrainMinimapIndices[] => {
    if (values.length > 256) throw new Error('presentation terrain minimap indices are invalid');
    const byte = (value: number) => Number.isInteger(value) && value >= 0 && value <= 255;
    return values.map((entry, index) => {
      if (
        !byte(entry.id) ||
        (index > 0 && values[index - 1]!.id >= entry.id) ||
        !byte(entry.highIndex) ||
        !byte(entry.mediumIndex) ||
        !byte(entry.lowIndex)
      ) {
        throw new Error('presentation terrain minimap indices are invalid');
      }
      return {
        id: entry.id,
        highIndex: entry.highIndex,
        mediumIndex: entry.mediumIndex,
        lowIndex: entry.lowIndex,
      };
    });
  };
  const unavailable = {
    objects: [],
    terrains: [],
    objectSlots: [],
    terrainSlotCount: 0,
    terrainMinimapIndices: [],
  };
  switch (response.status) {
    case PresentationStringIdsStatus.AVAILABLE: {
      const terrainSlotCount = response.terrainSlotCount ?? 0;
      if (!Number.isInteger(terrainSlotCount) || terrainSlotCount < 0 || terrainSlotCount > 256) {
        throw new Error('presentation terrain slot count is invalid');
      }
      return {
        status: 'available',
        objects: entries(response.objects, 65_535),
        terrains: entries(response.terrains, 65_535),
        objectSlots: slots(response.objectSlots ?? []),
        terrainSlotCount,
        terrainMinimapIndices: minimapIndices(response.terrainMinimapIndices ?? []),
      };
    }
    case PresentationStringIdsStatus.UNSUPPORTED_LAYOUT:
      return { status: 'unsupported-layout', ...unavailable };
    case PresentationStringIdsStatus.UNREADABLE:
      return { status: 'unreadable', ...unavailable };
    default:
      throw new Error('presentation string identity status is unknown');
  }
}

export function createEnvelope(requestId: string, payload: Envelope['payload']): Envelope {
  return create(EnvelopeSchema, {
    artifactVersion: create(ArtifactVersionSchema, protocolVersion),
    compatibility: create(CompatibilityRangeSchema, { minimumMajor: 2, maximumMajor: 2 }),
    requestId,
    payload,
  });
}

export function protocolSourceCatalog(catalog: MainSourceCatalog) {
  return create(SourceCatalogSchema, {
    contractVersion: create(ArtifactVersionSchema, catalog.contractVersion),
    revision: BigInt(catalog.revision),
    entryPath: catalog.entryPath,
    sources: catalog.sources.map((source) =>
      create(SourceCatalogEntrySchema, {
        normalizedPath: source.normalizedPath,
        sourceId: source.sourceId,
        rawHash: source.rawHash,
        source: source.source,
        origin: protocolSourceOrigin(source.origin),
        role: protocolSourceRole(source.role),
        ...(source.bufferRevision === undefined
          ? {}
          : { bufferRevision: BigInt(source.bufferRevision) }),
      }),
    ),
    roots: create(SourceCatalogRootsSchema, {
      openedOrConfigured: [...catalog.roots.openedOrConfigured],
      deployedMapContext: catalog.roots.deployedMapContext ?? '',
      gameGamedataX2: catalog.roots.gameGamedataX2 ?? '',
      implicitEnvironment: catalog.roots.implicitEnvironment ?? '',
      gameXs: catalog.roots.gameXs ?? '',
      standardIncludes: [...catalog.roots.standardIncludes],
      standardIncludesAuthorized: catalog.roots.standardIncludesAuthorized,
    }),
    caseSensitive: catalog.caseSensitive,
    profileId: catalog.profileId,
    contentIdentity: catalog.contentIdentity,
    implicitDefinitions: Object.entries(catalog.implicitDefinitions).map(([name, value]) =>
      create(ImplicitDefinitionSchema, { name, value }),
    ),
    implicitEnvironmentHash: catalog.implicitEnvironmentHash,
    catalogHash: catalog.catalogHash,
    rmsGraphHash: catalog.rmsGraphHash,
    externalAssetHash: catalog.externalAssetHash,
  });
}

function protocolSourceOrigin(origin: MainSourceCatalogOrigin): SourceCatalogOrigin {
  return {
    workspace: SourceCatalogOrigin.WORKSPACE,
    'dirty-buffer': SourceCatalogOrigin.DIRTY_BUFFER,
    'deployed-map': SourceCatalogOrigin.DEPLOYED_MAP,
    'game-data': SourceCatalogOrigin.GAME_DATA,
    'implicit-environment': SourceCatalogOrigin.IMPLICIT_ENVIRONMENT,
  }[origin];
}

function protocolSourceRole(role: MainSourceCatalogRole): SourceCatalogRole {
  return {
    'rms-entry': SourceCatalogRole.RMS_ENTRY,
    'rms-dependency': SourceCatalogRole.RMS_DEPENDENCY,
    'external-xs': SourceCatalogRole.EXTERNAL_XS,
  }[role];
}

function toPreviewResult(
  response: GenerationResponse,
  input: PreviewGenerationInput,
  sourceCatalog: MainSourceCatalog,
  generationEvents: PreviewGenerationEvent[] = [],
  playerColors: readonly number[] = [],
): PreviewGenerationResult {
  const map = response.mapState;
  const provenance = response.provenance;
  const document = response.document;
  const tileCount = (map?.width ?? 0) * (map?.height ?? 0);
  const objects = map?.objects;
  const connections = map?.connections;
  const objectCount = (objects?.idsLe.byteLength ?? 1) / 4;
  const connectionCount = connections?.kinds.byteLength ?? -1;
  if (
    !response.committed ||
    !map ||
    !provenance ||
    !document ||
    tileCount < 1 ||
    !objects ||
    !connections ||
    map.terrainIdsLe.byteLength !== tileCount * 4 ||
    map.preConnectionTerrainIdsLe.byteLength !== tileCount * 4 ||
    map.elevations.byteLength !== tileCount * 2 ||
    map.zonesLe.byteLength !== tileCount * 4 ||
    map.landIdsLe.byteLength !== tileCount * 4 ||
    map.cliffEdges.byteLength % 12 !== 0 ||
    map.cliffEdges.byteLength / 12 > tileCount * 8 ||
    !Number.isInteger(objectCount) ||
    objectCount > 1_000_000 ||
    objects.xLe.byteLength !== objectCount * 4 ||
    objects.yLe.byteLength !== objectCount * 4 ||
    objects.ownersLe.byteLength !== objectCount ||
    objects.facetsLe.byteLength !== objectCount * 2 ||
    objects.footprintWidths256Le.byteLength !== objectCount * 2 ||
    objects.footprintHeights256Le.byteLength !== objectCount * 2 ||
    objects.presentationKinds.byteLength !== objectCount ||
    objects.resourceTypeLe.byteLength !== objectCount * 2 ||
    objects.resourceQuantityF32BitsLe.byteLength !== objectCount * 4 ||
    objects.resourceDeltasLe.byteLength !== objectCount * 4 ||
    objects.statusesLe.byteLength !== objectCount * 4 ||
    objects.deathStates.byteLength !== objectCount ||
    objects.dataStatusesLe.byteLength !== objectCount * 2 ||
    objects.selectionFlags.byteLength !== objectCount ||
    objects.behaviorFlagsLe.byteLength !== objectCount * 2 ||
    map.layerIdsLe.byteLength !== tileCount * 2 ||
    map.flagsLe.byteLength !== tileCount * 4 ||
    connectionCount > tileCount * 8 ||
    connections.startXLe.byteLength !== connectionCount * 2 ||
    connections.startYLe.byteLength !== connectionCount * 2 ||
    connections.endXLe.byteLength !== connectionCount * 2 ||
    connections.endYLe.byteLength !== connectionCount * 2 ||
    provenance.tileSourceIndicesLe.byteLength !== tileCount * 2 ||
    provenance.tileByteStartsLe.byteLength !== tileCount * 4 ||
    provenance.tileByteEndsLe.byteLength !== tileCount * 4 ||
    provenance.tileOperationIndicesLe.byteLength !== tileCount * 4 ||
    provenance.objectOperationIndicesLe.byteLength !== objectCount * 4 ||
    provenance.cliffOperationIndicesLe.byteLength !== (map.cliffEdges.byteLength / 12) * 4 ||
    provenance.connectionOperationIndicesLe.byteLength !== connectionCount * 4 ||
    provenance.operations.length > 1_000_000 ||
    provenance.operations.some(
      (operation) =>
        operation.sourceId.length < 1 ||
        operation.sourceId.length > 4096 ||
        operation.byteStart > operation.byteEnd ||
        operation.operationIdentity.byteLength !== 32 ||
        operation.includeChain.length > 256 ||
        operation.displayName.length > 256,
    ) ||
    document.semanticHash.byteLength !== 32 ||
    response.semanticHash.byteLength !== 32 ||
    response.requestHash.byteLength !== 32 ||
    response.sourceCatalogRevision !== BigInt(sourceCatalog.revision) ||
    !equalBytes(response.sourceCatalogHash, sourceCatalog.catalogHash) ||
    !equalBytes(response.sourceGraphHash, sourceCatalog.rmsGraphHash) ||
    !equalBytes(response.externalAssetHash, sourceCatalog.externalAssetHash) ||
    !equalBytes(document.sourceGraphHash, sourceCatalog.rmsGraphHash) ||
    !equalBytes(document.sourceCatalogHash, sourceCatalog.catalogHash) ||
    response.resolvedRmsSourceIds.length > sourceCatalog.sources.length ||
    response.externalAssetSourceIds.length > sourceCatalog.sources.length ||
    !response.resolvedRmsSourceIds.every((sourceId) =>
      sourceCatalog.sources.some(
        (source) => source.sourceId === sourceId && source.role !== 'external-xs',
      ),
    ) ||
    !response.externalAssetSourceIds.every((sourceId) =>
      sourceCatalog.sources.some(
        (source) => source.sourceId === sourceId && source.role === 'external-xs',
      ),
    )
  ) {
    throw new Error('rmsd returned an invalid generated map');
  }
  const certification = toGenerationCertification(response.certification);
  const playerColorIds = Array.from({ length: 9 }, () => -1);
  const playerCivilizationIds = Array.from({ length: 9 }, () => -1);
  input.players.forEach((player, index) => {
    playerColorIds[player.slot] = playerColors[index] ?? player.slot - 1;
    playerCivilizationIds[player.slot] = player.civilizationId;
  });
  const executionCost = toExecutionCostSummary(response.executionCost);
  const constructVerification = toConstructVerification(
    response.constructVerification,
    provenance.operations.length,
  );
  return {
    backend: input.backend,
    certification,
    ...(constructVerification ? { constructVerification } : {}),
    ...(executionCost ? { executionCost } : {}),
    backendIdentity: input.backend === 'synthetic' ? 'synthetic-generation-v1' : 'exact-rms-v1',
    playerColorIds,
    playerCivilizationIds,
    presentationSeed: input.seed,
    objectNames: input.contentPack.objectNames.map((entry) => ({ ...entry })),
    graphiclessObjectIds: [...(input.contentPack.graphiclessObjectIds ?? [])],
    mapIconArtObjects: mapIconArtObjectDescriptors(input.contentPack),
    terrainNames: [],
    ...constantNamesFor(input.contentPack),
    minimapPalette: input.minimapPalette ? structuredClone(input.minimapPalette) : null,
    ...(input.texturePalette ? { texturePalette: structuredClone(input.texturePalette) } : {}),
    documentUri: document.uri,
    documentRevision: Number(document.revision),
    semanticProgramHash: toHex(document.semanticHash),
    width: map.width,
    height: map.height,
    terrainIdsLe: Uint8Array.from(map.terrainIdsLe),
    preConnectionTerrainIdsLe: Uint8Array.from(map.preConnectionTerrainIdsLe),
    elevations: Uint8Array.from(map.elevations),
    terrainZonesLe: Uint8Array.from(map.zonesLe),
    landIdsLe: Uint8Array.from(map.landIdsLe),
    cliffEdges: Uint8Array.from(map.cliffEdges),
    ...(map.cliffPiecesLe.byteLength > 0 &&
    decodeCliffPieceColumn(map.cliffPiecesLe, map.width, map.height)
      ? { cliffPiecesLe: Uint8Array.from(map.cliffPiecesLe) }
      : {}),
    ...(map.appearanceObjectsLe.byteLength > 0 &&
    decodeAppearanceObjectColumn(map.appearanceObjectsLe, map.width, map.height)
      ? { appearanceObjectsLe: Uint8Array.from(map.appearanceObjectsLe) }
      : {}),
    objects: {
      idsLe: Uint8Array.from(objects.idsLe),
      xLe: Uint8Array.from(objects.xLe),
      yLe: Uint8Array.from(objects.yLe),
      owners: Uint8Array.from(objects.ownersLe),
      facetsLe: Uint8Array.from(objects.facetsLe),
      footprintWidths256Le: Uint8Array.from(objects.footprintWidths256Le),
      footprintHeights256Le: Uint8Array.from(objects.footprintHeights256Le),
      presentationKinds: Uint8Array.from(objects.presentationKinds),
      resourceTypeLe: Uint8Array.from(objects.resourceTypeLe),
      resourceQuantityF32BitsLe: Uint8Array.from(objects.resourceQuantityF32BitsLe),
      resourceDeltasLe: Uint8Array.from(objects.resourceDeltasLe),
      statusesLe: Uint8Array.from(objects.statusesLe),
      deathStates: Uint8Array.from(objects.deathStates),
      dataStatusesLe: Uint8Array.from(objects.dataStatusesLe),
      selectionFlags: Uint8Array.from(objects.selectionFlags),
      behaviorFlagsLe: Uint8Array.from(objects.behaviorFlagsLe),
    },
    layerIdsLe: Uint8Array.from(map.layerIdsLe),
    flagsLe: Uint8Array.from(map.flagsLe),
    connections: {
      startXLe: Uint8Array.from(connections.startXLe),
      startYLe: Uint8Array.from(connections.startYLe),
      endXLe: Uint8Array.from(connections.endXLe),
      endYLe: Uint8Array.from(connections.endYLe),
      kinds: Uint8Array.from(connections.kinds),
    },
    ...connectionRoutesField(map.connectionRoutes, {
      width: map.width,
      height: map.height,
      connections,
      connectionOperationIndicesLe: provenance.connectionOperationIndicesLe,
      operationCount: provenance.operations.length,
    }),
    sourceIds: [...provenance.sourceIds],
    tileSourceIndicesLe: Uint8Array.from(provenance.tileSourceIndicesLe),
    tileByteStartsLe: Uint8Array.from(provenance.tileByteStartsLe),
    tileByteEndsLe: Uint8Array.from(provenance.tileByteEndsLe),
    provenanceOperations: provenance.operations.map((operation) => ({
      sourceId: operation.sourceId,
      byteStart: operation.byteStart,
      byteEnd: operation.byteEnd,
      operationIdentity: toHex(operation.operationIdentity),
      includeChain: [...operation.includeChain],
      displayName: operation.displayName,
    })),
    provenanceStatus: 'exact',
    tileOperationIndicesLe: Uint8Array.from(provenance.tileOperationIndicesLe),
    objectOperationIndicesLe: Uint8Array.from(provenance.objectOperationIndicesLe),
    cliffOperationIndicesLe: Uint8Array.from(provenance.cliffOperationIndicesLe),
    connectionOperationIndicesLe: Uint8Array.from(provenance.connectionOperationIndicesLe),
    semanticHash: toHex(response.semanticHash),
    requestHash: toHex(response.requestHash),
    sourceCatalogRevision: sourceCatalog.revision,
    sourceCatalogHash: toHex(sourceCatalog.catalogHash),
    sourceGraphHash: toHex(sourceCatalog.rmsGraphHash),
    externalAssetHash: toHex(sourceCatalog.externalAssetHash),
    resolvedRmsSourceIds: [...response.resolvedRmsSourceIds],
    externalAssetSourceIds: [...response.externalAssetSourceIds],
    stageHashes: response.stageHashes.map((stage) => ({
      stage: stage.stage,
      hash: toHex(stage.hash),
    })),
    warnings: response.warnings.map((warning) => ({ ...warning })),
    metrics: Object.fromEntries(
      Object.entries(response.metrics).map(([name, value]) => [name, Number(value)]),
    ),
    generationEvents,
    traceIdentity: {
      profileId: input.profile.profileId,
      profileHash: input.profile.profileHash,
      contentPackId: input.contentPack.packId,
      contentPackVersion: input.contentPack.packVersion,
      contentPackHash: input.contentPack.contentHash,
      traceLevel: input.traceLevel,
    },
  };
}

export function toPreviewConnectionRoutes(
  routes: ProtocolConnectionRoutes | undefined,
  context: ConnectionRouteContext,
): PreviewConnectionRoutesPayload | undefined {
  if (!routes) return undefined;
  if (routes.formatMajor !== connectionRoutesFormatMajor) return { state: 'invalid' };
  const payload = {
    totalAttempts: uint64Number(routes.totalAttempts),
    successfulAttempts: uint64Number(routes.successfulAttempts),
    failedAttempts: uint64Number(routes.failedAttempts),
    retainedAttempts: routes.retainedAttempts,
    retainedSuccessfulAttempts: routes.retainedSuccessfulAttempts,
    omissionReasons: routes.omissionReasons,
    recordsLe: routes.recordsLe,
    verticesLe: routes.verticesLe,
  };
  if (typeof validateConnectionRoutes(payload, context) === 'string') return { state: 'invalid' };
  return {
    state: 'available',
    formatMinor: routes.formatMinor,
    ...payload,
    recordsLe: Uint8Array.from(routes.recordsLe),
    verticesLe: Uint8Array.from(routes.verticesLe),
  };
}

function connectionRoutesField(
  routes: ProtocolConnectionRoutes | undefined,
  context: ConnectionRouteContext,
): { connectionRoutes?: PreviewConnectionRoutesPayload } {
  const connectionRoutes = toPreviewConnectionRoutes(routes, context);
  return connectionRoutes ? { connectionRoutes } : {};
}

function uint64Number(value: bigint): number {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : -1;
}

function toExecutionCostStepRecord(step: ProtocolExecutionCostStep | undefined) {
  if (!step || step.counters.length > maximumStepCounters) return undefined;
  return {
    step: step.step,
    durationUs: uint64Number(step.durationUs),
    counters: step.counters.map((counter) => ({
      counter: counter.counter,
      value: uint64Number(counter.value),
    })),
  };
}

export function toExecutionCostSummary(
  summary: ProtocolExecutionCostSummary | undefined,
): ExecutionCostSummary | undefined {
  if (!summary || summary.groups.length > maximumExecutionGroups) return undefined;
  if (
    summary.groups.reduce((total, group) => total + group.steps.length, 0) > maximumExecutionSteps
  ) {
    return undefined;
  }
  return parseExecutionCostSummary({
    contractMajor: summary.contractMajor,
    contractMinor: summary.contractMinor,
    totalUs: uint64Number(summary.totalUs),
    context:
      summary.context === ProtocolExecutionCostContext.ISOLATED
        ? 'isolated'
        : summary.context === ProtocolExecutionCostContext.MAP_TEST
          ? 'map-test'
          : 'unspecified',
    groups: summary.groups.map((group) => ({
      group: group.group,
      durationUs: uint64Number(group.durationUs),
      steps: group.steps.map(toExecutionCostStepRecord),
    })),
  });
}

const candidateStages: Partial<Record<VisualCheckpointStage, PreviewCandidateStage>> = {
  [VisualCheckpointStage.LAND]: 'land',
  [VisualCheckpointStage.ELEVATION]: 'elevation',
  [VisualCheckpointStage.CLIFFS]: 'cliffs',
  [VisualCheckpointStage.TERRAIN]: 'terrain',
  [VisualCheckpointStage.CONNECTIONS]: 'connections',
  [VisualCheckpointStage.OBJECTS]: 'objects',
  [VisualCheckpointStage.SAMPLE_COMPLETE]: 'sample-complete',
};

export function toPreviewCandidate(
  event: VisualCheckpointEvent,
  envelopeRequestId: string,
): PreviewCandidate | undefined {
  const stage = candidateStages[event.stage];
  if (
    event.identity?.requestId !== envelopeRequestId ||
    event.contractMajor !== previewCandidateContractMajor ||
    !stage ||
    event.chunks.length > maximumPreviewCandidateChunks
  ) {
    return undefined;
  }
  try {
    return validatePreviewCandidate({
      requestId: envelopeRequestId,
      revision: uint64Number(event.revision),
      baseRevision: uint64Number(event.baseRevision),
      stage,
      width: event.width,
      height: event.height,
      elapsedUs: uint64Number(event.elapsedUs),
      ...(event.sample
        ? { sample: { ordinal: event.sample.ordinal, seed: event.sample.seed } }
        : {}),
      chunks: event.chunks.map((chunk) => ({
        chunkX: chunk.chunkX,
        chunkY: chunk.chunkY,
        terrainIdsLe: chunk.terrainIdsLe,
        elevations: chunk.elevations,
        cliffEdges: chunk.cliffEdges,
        objects: chunk.objects,
      })),
    });
  } catch {
    return undefined;
  }
}

export function toExecutionProgressEvent(
  event: ProtocolExecutionProgressEvent,
  envelopeRequestId: string,
): ExecutionProgressEvent | undefined {
  if (
    event.identity?.requestId !== envelopeRequestId ||
    event.contractMajor !== 1 ||
    event.plan.length > maximumExecutionSteps
  ) {
    return undefined;
  }
  try {
    return validateExecutionProgressEvent(
      event.kind === ExecutionProgressKind.STARTED
        ? { requestId: envelopeRequestId, kind: 'started', plan: [...event.plan] }
        : event.kind === ExecutionProgressKind.STEP_COMPLETED
          ? {
              requestId: envelopeRequestId,
              kind: 'step-completed',
              step: toExecutionCostStepRecord(event.step),
              completedSteps: event.completedSteps,
              measuredTotalUs: uint64Number(event.measuredTotalUs),
              elapsedUs: uint64Number(event.elapsedUs),
            }
          : { requestId: envelopeRequestId, kind: 'unspecified' },
    );
  } catch {
    return undefined;
  }
}

export function toGenerationCertification(value: number): GenerationCertification {
  switch (value) {
    case ProtocolGenerationCertification.VERSION_MAPPED:
      return 'version-mapped';
    case ProtocolGenerationCertification.UNVERIFIED_PRODUCT_VERSION:
      return 'unverified-product-version';
    default:
      throw new Error('rmsd returned an unsupported generation certification');
  }
}

export function toConstructVerification(
  value: ProtocolConstructVerification | undefined,
  operationCount: number,
): ConstructVerification | undefined {
  if (!value) return undefined;
  if (value.uncertified.some(({ firstOperationIndex }) => firstOperationIndex >= operationCount)) {
    return undefined;
  }
  const status =
    value.status === ProtocolConstructVerificationStatus.ALL_CERTIFIED
      ? 'all-certified'
      : value.status === ProtocolConstructVerificationStatus.UNCERTIFIED_CONSTRUCTS
        ? 'uncertified-constructs'
        : null;
  if (!status) return undefined;
  return (
    parseConstructVerification({
      status,
      uncertified: value.uncertified.map(({ context, name, firstOperationIndex }) => ({
        context,
        name,
        firstOperationIndex,
      })),
      omittedUncertified: value.omittedUncertified,
      executedConstructs: value.executedConstructs,
      tableId: value.tableId,
    }) ?? undefined
  );
}

export function toPreviewGenerationEvent(event: ProtocolGenerationEvent): PreviewGenerationEvent {
  const sequence = Number(event.sequence);
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    (event.stateHash.byteLength !== 0 && event.stateHash.byteLength !== 32) ||
    event.detail.length > 4096
  ) {
    throw new Error('rmsd returned an invalid generation event');
  }
  const tiles = event.delta?.tiles ?? [];
  const objects = event.delta?.objects ?? [];
  const cliffs = event.delta?.cliffs ?? [];
  const connections = event.delta?.connections ?? [];
  const initialization = event.initialization;
  const initializationOperations = initialization?.provenanceOperations ?? [];
  if (
    tiles.length > 1024 ||
    objects.length > 256 ||
    objects.some(
      (mutation) =>
        mutation.resourceType < -32768 ||
        mutation.resourceType > 32767 ||
        mutation.deathState < -128 ||
        mutation.deathState > 127 ||
        mutation.dataStatus < -32768 ||
        mutation.dataStatus > 32767 ||
        mutation.selectionFlags > 255 ||
        mutation.behaviorFlags > 65535,
    ) ||
    cliffs.length > 256 ||
    connections.length > 256 ||
    (initialization &&
      (initialization.width < 1 ||
        initialization.height < 1 ||
        initialization.width > 512 ||
        initialization.height > 512 ||
        initialization.sourceCatalogRevision > BigInt(Number.MAX_SAFE_INTEGER) ||
        initialization.semanticProgramHash.byteLength !== 32 ||
        initialization.requestHash.byteLength !== 32 ||
        initialization.sourceCatalogHash.byteLength !== 32 ||
        initialization.sourceGraphHash.byteLength !== 32 ||
        initialization.externalAssetHash.byteLength !== 32 ||
        initialization.backendIdentity.length < 1 ||
        initialization.backendIdentity.length > 256 ||
        initializationOperations.length > 1_000_000 ||
        initializationOperations.some(
          (operation) =>
            operation.sourceId.length < 1 ||
            operation.sourceId.length > 4096 ||
            operation.byteStart > operation.byteEnd ||
            operation.operationIdentity.byteLength !== 32 ||
            operation.includeChain.length > 256 ||
            operation.includeChain.some(
              (sourceId) => sourceId.length < 1 || sourceId.length > 4096,
            ) ||
            operation.displayName.length > 256,
        )))
  ) {
    throw new Error('rmsd returned an invalid generation event payload');
  }
  return {
    requestId: event.identity?.requestId ?? '',
    sequence,
    kind: generationEventKind(event.kind),
    stage: event.stage,
    completed: event.completed,
    total: event.total,
    ...(event.stateHash.byteLength === 32 ? { stateHash: toHex(event.stateHash) } : {}),
    ...(event.delta
      ? {
          delta: {
            tiles: tiles.map((mutation) => ({
              tileIndex: mutation.tileIndex,
              terrainId: mutation.terrainId,
              elevation: mutation.elevation,
              terrainZone: mutation.terrainZone,
              landId: mutation.landId,
              layerId: mutation.layerId,
              flags: mutation.flags,
              operation: mutationOperation(mutation.operation),
              provenanceOperationIndex: mutation.provenanceOperationIndex,
            })),
            objects: objects.map((mutation) => ({
              objectIndex: mutation.objectIndex,
              objectId: mutation.objectId,
              x256: mutation.x256,
              y256: mutation.y256,
              owner: mutation.owner,
              facet: mutation.facet,
              footprintWidth256: mutation.footprintWidth256,
              footprintHeight256: mutation.footprintHeight256,
              presentationKind: mutation.presentationKind,
              resourceType: mutation.resourceType,
              resourceQuantityF32Bits: mutation.resourceQuantityF32Bits,
              operation: mutationOperation(mutation.operation),
              provenanceOperationIndex: mutation.provenanceOperationIndex,
            })),
            cliffs: cliffs.map((mutation) => ({
              cliffIndex: mutation.cliffIndex,
              fromX: mutation.fromX,
              fromY: mutation.fromY,
              toX: mutation.toX,
              toY: mutation.toY,
              cliffType: mutation.cliffType,
              operation: mutationOperation(mutation.operation),
              provenanceOperationIndex: mutation.provenanceOperationIndex,
            })),
            connections: connections.map((mutation) => ({
              connectionIndex: mutation.connectionIndex,
              startX: mutation.startX,
              startY: mutation.startY,
              endX: mutation.endX,
              endY: mutation.endY,
              kind: mutation.kind,
              operation: mutationOperation(mutation.operation),
              provenanceOperationIndex: mutation.provenanceOperationIndex,
            })),
          },
        }
      : {}),
    ...(initialization
      ? {
          initialization: {
            width: initialization.width,
            height: initialization.height,
            backendIdentity: initialization.backendIdentity,
            semanticProgramHash: toHex(initialization.semanticProgramHash),
            requestHash: toHex(initialization.requestHash),
            sourceCatalogRevision: Number(initialization.sourceCatalogRevision),
            sourceCatalogHash: toHex(initialization.sourceCatalogHash),
            sourceGraphHash: toHex(initialization.sourceGraphHash),
            externalAssetHash: toHex(initialization.externalAssetHash),
            provenanceOperations: initialization.provenanceOperations.map((operation) => ({
              sourceId: operation.sourceId,
              byteStart: operation.byteStart,
              byteEnd: operation.byteEnd,
              operationIdentity: toHex(operation.operationIdentity),
              includeChain: [...operation.includeChain],
              displayName: operation.displayName,
            })),
          },
        }
      : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };
}

function mutationOperation(operation: MutationOperation): 'replace' | 'remove' {
  switch (operation) {
    case MutationOperation.REPLACE:
      return 'replace';
    case MutationOperation.REMOVE:
      return 'remove';
    default:
      throw new Error('rmsd returned an unspecified mutation operation');
  }
}

function internalFixtureScenario(
  fixtureId: DevelopmentFixtureDescriptor['id'] | undefined,
): InternalFixtureScenario {
  switch (fixtureId) {
    case undefined:
      return InternalFixtureScenario.UNSPECIFIED;
    case 'representative':
      return InternalFixtureScenario.REPRESENTATIVE;
    case 'colocated':
      return InternalFixtureScenario.COLOCATED;
    case 'legend':
      return InternalFixtureScenario.LEGEND;
    case 'large':
      return InternalFixtureScenario.LARGE;
    case 'delayed':
      return InternalFixtureScenario.DELAYED;
    case 'failure':
      return InternalFixtureScenario.FAILURE;
    case 'cancellable':
      return InternalFixtureScenario.CANCELLABLE;
  }
}

function generationEventKind(kind: GenerationEventKind): PreviewGenerationEvent['kind'] {
  switch (kind) {
    case GenerationEventKind.GENERATION_STARTED:
      return 'generation-started';
    case GenerationEventKind.STAGE_STARTED:
      return 'stage-started';
    case GenerationEventKind.DELTA_BATCH:
      return 'delta-batch';
    case GenerationEventKind.STAGE_COMPLETED:
      return 'stage-completed';
    case GenerationEventKind.GENERATION_COMPLETED:
      return 'generation-completed';
    case GenerationEventKind.FAILED:
      return 'failed';
    case GenerationEventKind.CANCELLED:
      return 'cancelled';
    case GenerationEventKind.DIAGNOSTIC:
      return 'diagnostic';
    default:
      throw new Error('rmsd returned an unknown generation event kind');
  }
}

export function toConfigurationCatalog(
  response: ConfigurationCatalogResponse,
): ConfigurationCatalog {
  const behaviorProfiles = response.behaviorProfiles.map((profile) => {
    if (profile.profileHash.byteLength !== 32) throw new Error('catalog profile hash is invalid');
    const capabilities: Record<string, 'unsupported' | 'partial' | 'complete'> = {};
    for (const [name, value] of Object.entries(profile.capabilities)) {
      if (value !== 'unsupported' && value !== 'partial' && value !== 'complete') {
        throw new Error('catalog capability status is invalid');
      }
      capabilities[name] = value;
    }
    if (
      profile.minimapPalettes.length > 256 ||
      profile.minimapPalettes.some(
        (palette, paletteIndex) =>
          palette.paletteHash.byteLength !== 32 ||
          palette.paletteId.length < 1 ||
          palette.paletteId.length > 96 ||
          palette.productVersion.length < 1 ||
          palette.productVersion.length > 64 ||
          (paletteIndex > 0 &&
            compareProductVersions(
              profile.minimapPalettes[paletteIndex - 1]!.productVersion,
              palette.productVersion,
            ) >= 0) ||
          !validMinimapPaletteMappings(palette),
      )
    ) {
      throw new Error('catalog minimap palette is invalid');
    }
    return {
      profileId: profile.profileId,
      behaviorVersion: profile.behaviorVersion,
      profileHash: toHex(profile.profileHash),
      productVersions: [...profile.productVersions],
      capabilities,
      minimapPalettes: profile.minimapPalettes.map((palette) => ({
        paletteId: palette.paletteId,
        productVersion: palette.productVersion,
        paletteHash: toHex(palette.paletteHash),
        terrainColors: palette.terrainColors.map((color) => ({ ...color })),
        neutralObjectColors: palette.neutralObjectColors.map((color) => ({ ...color })),
        cliffColors: palette.cliffColors.map((color) => ({ ...color })),
      })),
      texturePalettes: toTexturePaletteDescriptors(profile.texturePalettes),
    };
  });
  const contentPacks = response.contentPacks.map(toContentPackDescriptor);
  return { behaviorProfiles, contentPacks };
}

const gameArtPhases = new Map<number, GameArtPhase>([
  [ProtocolGameArtPhase.CATALOG, 'catalog'],
  [ProtocolGameArtPhase.TERRAIN, 'terrain'],
  [ProtocolGameArtPhase.BLENDS, 'blends'],
  [ProtocolGameArtPhase.MASKS, 'masks'],
  [ProtocolGameArtPhase.SPRITES, 'sprites'],
]);

export function toGameArtProgress(event: {
  phase: number;
  completed: number;
  total: number;
}): GameArtNativeProgress | null {
  const phase = gameArtPhases.get(event.phase);
  if (!phase || event.completed > event.total || event.total > 1_000_000) return null;
  return { phase, completed: event.completed, total: event.total };
}

export function protocolGameArtSource(source: GameArtNativeSource) {
  return create(GameArtSourceSchema, {
    installationRoot: source.installationRoot,
    productVersion: source.productVersion,
    cacheRoot: source.cacheRoot,
  });
}

function cancelledGameArt(): GameArtNativeResult {
  return { ...unsupportedGameArt(), status: 'cancelled', message: 'cancelled' };
}

function unsupportedGameArt(): GameArtNativeResult {
  return {
    status: 'unsupported',
    message: 'rmsd does not convert game art',
    cacheKey: '',
    converted: 0,
    reused: 0,
    fallbacks: [],
    fallbackCount: 0,
    cacheBytes: 0,
    elapsedMicroseconds: 0,
    evicted: 0,
  };
}

export function toGameArtResult(response: ProtocolGameArtResponse): GameArtNativeResult {
  const statuses = new Map<number, GameArtNativeResult['status']>([
    [ProtocolGameArtStatus.AVAILABLE, 'available'],
    [ProtocolGameArtStatus.UNREADABLE, 'unreadable'],
    [ProtocolGameArtStatus.UNSUPPORTED_LAYOUT, 'unsupported-layout'],
    [ProtocolGameArtStatus.CANCELLED, 'cancelled'],
    [ProtocolGameArtStatus.INVALID, 'invalid'],
  ]);
  const status = statuses.get(response.status);
  if (!status) throw new Error('game art response status is unknown');
  if (status === 'available' && !/^[0-9a-f]{32}$/u.test(response.cacheKey)) {
    throw new Error('game art response cache key is invalid');
  }
  return {
    status,
    message: response.message.slice(0, 1024),
    cacheKey: response.cacheKey,
    converted: response.converted,
    reused: response.reused,
    fallbacks: response.fallbacks.slice(0, 256).map((fallback) => ({
      asset: fallback.asset.slice(0, 128),
      reason: fallback.reason.slice(0, 512),
    })),
    fallbackCount: Math.max(response.fallbackCount, response.fallbacks.length),
    cacheBytes: Number(response.cacheBytes),
    elapsedMicroseconds: Number(response.elapsedMicroseconds),
    evicted: response.evicted,
  };
}

export function protocolLocalContentSource(source: LocalContentSource) {
  return create(LocalContentSourceSchema, {
    datPath: source.datPath,
    objectReplacementsPath: source.objectReplacementsPath,
    definitionsPath: source.definitionsPath,
    productVersion: source.productVersion,
    profileId: source.profileId,
  });
}

export function toLocalContentImportResult(
  response: LocalContentImportResponse,
): LocalContentImportResult {
  const message = response.message.slice(0, 1024);
  switch (response.status) {
    case LocalContentImportStatus.AVAILABLE: {
      if (!response.contentPack) throw new Error('local content response lacks its pack');
      const contentPack = toContentPackDescriptor(response.contentPack);
      if (contentPack.packagedBundle || contentPack.synthetic) {
        throw new Error('local content response is not a local pack');
      }
      return {
        status: 'available',
        contentPack,
        importMicroseconds: Number(response.importMicroseconds),
      };
    }
    case LocalContentImportStatus.UNREADABLE:
      return { status: 'unreadable', message };
    case LocalContentImportStatus.UNSUPPORTED_LAYOUT:
      return { status: 'unsupported-layout', message };
    case LocalContentImportStatus.INVALID:
      return { status: 'invalid', message };
    default:
      throw new Error('rmsd returned an unknown local content status');
  }
}

function toContentPackDescriptor(pack: ProtocolContentPackDescriptor): ContentPackDescriptor {
  {
    if (pack.contentHash.byteLength !== 32 || !/^[0-9a-f]{64}$/.test(pack.sourceFingerprint)) {
      throw new Error('catalog content identity is invalid');
    }
    if (
      pack.objectNames.length > 100_000 ||
      pack.objectNames.some(
        (entry, index) =>
          entry.name.length < 1 ||
          entry.name.length > 256 ||
          (index > 0 && pack.objectNames[index - 1]!.objectId >= entry.objectId),
      )
    ) {
      throw new Error('catalog object names are invalid');
    }
    if (
      pack.implicitDefinitions.length > 65_536 ||
      pack.implicitDefinitions.some(
        (entry, index) =>
          entry.name.length < 1 ||
          entry.name.length > 256 ||
          entry.value.length < 1 ||
          entry.value.length > 256 ||
          (index > 0 && pack.implicitDefinitions[index - 1]!.name >= entry.name),
      )
    ) {
      throw new Error('catalog implicit definitions are invalid');
    }
    if (
      pack.standardIncludes.length > 4096 ||
      pack.standardIncludes.some(
        (path) => path.length < 1 || path.length > 4096 || path.includes('..'),
      ) ||
      pack.productVersion.length > 64 ||
      pack.packagedBundle !== pack.productVersion.length > 0
    ) {
      throw new Error('catalog version resources are invalid');
    }
    if (
      pack.graphiclessObjectIds.length > pack.objectNames.length ||
      pack.graphiclessObjectIds.some(
        (id, index) =>
          !Number.isInteger(id) ||
          id < 0 ||
          (index > 0 && pack.graphiclessObjectIds[index - 1]! >= id),
      )
    ) {
      throw new Error('catalog graphicless object identities are invalid');
    }
    if (
      [pack.treeObjectIds, pack.goldObjectIds, pack.stoneObjectIds].some(
        (ids) => !isAscendingObjectIdList(ids, pack.objectNames.length),
      )
    ) {
      throw new Error('catalog map icon art classes are invalid');
    }
    return {
      packId: pack.packId,
      packVersion: pack.packVersion,
      contentHash: toHex(pack.contentHash),
      sourceFingerprint: pack.sourceFingerprint,
      compatibleProfileIds: [...pack.compatibleProfileIds],
      synthetic: pack.synthetic,
      objectNames: pack.objectNames.map((entry) => ({
        objectId: entry.objectId,
        name: entry.name,
      })),
      implicitDefinitions: Object.fromEntries(
        pack.implicitDefinitions.map((entry) => [entry.name, entry.value]),
      ),
      standardIncludes: [...pack.standardIncludes],
      productVersion: pack.productVersion,
      packagedBundle: pack.packagedBundle,
      graphiclessObjectIds: [...pack.graphiclessObjectIds],
      treeObjectIds: [...pack.treeObjectIds],
      goldObjectIds: [...pack.goldObjectIds],
      stoneObjectIds: [...pack.stoneObjectIds],
    };
  }
}

function toTexturePaletteDescriptors(
  palettes: ConfigurationCatalogResponse['behaviorProfiles'][number]['texturePalettes'],
): TexturePaletteDescriptor[] {
  if (palettes.length > 256) throw new Error('catalog texture palette is invalid');
  return palettes.map((palette, index) => {
    const descriptor: TexturePaletteDescriptor = {
      paletteId: palette.paletteId,
      productVersion: palette.productVersion,
      paletteHash: palette.paletteHash.byteLength === 32 ? toHex(palette.paletteHash) : '',
      terrainColors: palette.terrainColors.map(({ terrainId, color }) => ({ terrainId, color })),
      objectColors: palette.objectColors.map(({ objectId, color }) => ({ objectId, color })),
      cliffColors: palette.cliffColors.map(({ cliffType, color }) => ({ cliffType, color })),
      provenance: {
        tool: palette.derivationTool,
        installationBuild: palette.installationBuild,
        derivedOn: palette.derivedOn,
      },
    };
    if (
      !isTexturePaletteDescriptor(descriptor) ||
      (index > 0 &&
        compareProductVersions(palettes[index - 1]!.productVersion, palette.productVersion) >= 0)
    ) {
      throw new Error('catalog texture palette is invalid');
    }
    return descriptor;
  });
}

function validMinimapPaletteMappings(palette: ProtocolMinimapPaletteDescriptor): boolean {
  const validColor = (color: number) => Number.isInteger(color) && color >= 0 && color <= 0xffffff;
  return (
    palette.terrainColors.length > 0 &&
    palette.terrainColors.length <= 4096 &&
    palette.terrainColors.every(
      (color, index) =>
        (index === 0 || palette.terrainColors[index - 1]!.terrainId < color.terrainId) &&
        validColor(color.highColor) &&
        validColor(color.mediumColor) &&
        validColor(color.lowColor),
    ) &&
    palette.neutralObjectColors.length > 0 &&
    palette.neutralObjectColors.length <= 100_000 &&
    palette.neutralObjectColors.every(
      (color, index) =>
        (index === 0 || palette.neutralObjectColors[index - 1]!.objectId < color.objectId) &&
        validColor(color.color),
    ) &&
    palette.cliffColors.length > 0 &&
    palette.cliffColors.length <= 4096 &&
    palette.cliffColors.every(
      (color, index) =>
        (index === 0 || palette.cliffColors[index - 1]!.cliffType < color.cliffType) &&
        validColor(color.leftColor) &&
        validColor(color.rightColor),
    )
  );
}

function compareProductVersions(left: string, right: string): number {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  if (
    leftParts.some((part) => !Number.isSafeInteger(part) || part < 0) ||
    rightParts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return left.localeCompare(right);
  }
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const order = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (order !== 0) return order;
  }
  return 0;
}

function fromHex(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

const controlPipeExchangeStatuses: Readonly<
  Partial<Record<ProtocolControlPipeExchangeStatus, ControlPipeExchangeStatus>>
> = {
  [ProtocolControlPipeExchangeStatus.COMPLETE]: 'complete',
  [ProtocolControlPipeExchangeStatus.UNAVAILABLE]: 'unavailable',
  [ProtocolControlPipeExchangeStatus.SERVER_PROCESS_MISMATCH]: 'server-process-mismatch',
  [ProtocolControlPipeExchangeStatus.SERVER_PROCESS_UNKNOWN]: 'server-process-unknown',
  [ProtocolControlPipeExchangeStatus.FAILED]: 'failed',
  [ProtocolControlPipeExchangeStatus.RESPONSE_TOO_LARGE]: 'response-too-large',
  [ProtocolControlPipeExchangeStatus.TIMED_OUT]: 'timed-out',
  [ProtocolControlPipeExchangeStatus.CANCELLED]: 'cancelled',
  [ProtocolControlPipeExchangeStatus.INVALID]: 'invalid',
};

export function toControlPipeExchangeResult(
  response: ProtocolControlPipeExchangeResponse,
  chunks: readonly Uint8Array[],
  received: number,
  maximumResponseBytes: number,
): ControlPipeExchangeResult {
  const status = controlPipeExchangeStatuses[response.status];
  if (!status) throw new Error('unknown AoE2Control exchange status');
  if (status !== 'complete') return { status, response: Buffer.alloc(0) };
  if (received > maximumResponseBytes) {
    return { status: 'response-too-large', response: Buffer.alloc(0) };
  }
  if (BigInt(received) !== response.responseBytes) {
    throw new Error('AoE2Control exchange answer is incomplete');
  }
  return { status, response: Buffer.concat(chunks, received) };
}

export function toHex(value: Uint8Array): string {
  return Buffer.from(value).toString('hex');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
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
