import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import {
  ArtifactVersionSchema,
  CancellationRequestSchema,
  CompatibilityRangeSchema,
  EnvelopeSchema,
  HandshakeRequestSchema,
  MapTestRunRequestSchema,
  MapTestStatus,
  PlayerConfigurationSchema,
  RequestIdentitySchema,
  ShutdownRequestSchema,
  type Envelope,
  type MapTestPreview,
  type MapTestRunResponse,
} from '../generated/rmside/v1/rmside_pb';
import type {
  LanguageServerDiagnostic,
  MapTestEvent,
  MapTestRunInput,
  MapTestRunResult,
  NativeProcessStatus,
  PreviewGenerationResult,
} from '../shared/api';
import { DesktopError, desktopErrorMessage } from '../shared/desktop-error';
import { mapIconArtObjectDescriptors } from '../shared/map-icon-art-objects';
import { isMapTestProgressCounts, mapTestWorkerRequest } from '../shared/map-test-contract';
import { guardChildStreams, isClosedPipeError } from './child-streams';
import { constantNamesFor } from './constant-names-provider';
import { encodeFrame, FrameDecoder } from './framing';
import type { LocalContentSource } from './local-content-service';
import { protocolLocalContentSource, toExecutionCostSummary } from './protocol-client';
import { validateMapTestReportJson } from './map-test-report';
import {
  createEnvelope,
  decodeRendererSetupContext,
  protocolSetupContext,
  protocolSourceCatalog,
  toHex,
} from './protocol-client';
import type { MainSourceCatalog } from './source-catalog-service';

interface PendingRequest {
  expectedCase: string;
  lastOutputOrdinal: number;
  lastPreviewOrdinal: number;
  lastProgress: { completed: number; requested: number };
  onEvent?: (event: MapTestEvent) => void;
  decodePreview?: (preview: MapTestPreview) => PreviewGenerationResult;
  resolve(message: Envelope): void;
  reject(error: Error): void;
}

const maximumStderrTailCharacters = 4096;

const statusStackOverflow = 0xc00000fd;
const statusNoMemory = 0xc0000017;
const statusFailFast = 0xc0000409;

export function describeMapTestChildExit(
  code: number | null,
  signal: string | null,
  stderrTail: string,
): string {
  const exit = `rms-test exited (code ${String(code)}, signal ${String(signal)})`;
  if (code === statusNoMemory || /memory allocation of \d+ bytes failed/u.test(stderrTail)) {
    return desktopErrorMessage(
      'map-test.child-memory',
      `The map-test run exceeded the map-test child's memory limit and was stopped. Reduce what the script allocates, such as large repetitions or many retained maps. The run was not retried. (${exit})`,
    );
  }
  if (code === statusStackOverflow || stderrTail.includes('has overflowed its stack')) {
    return desktopErrorMessage(
      'map-test.child-stack',
      `The map-test run nested values or calls too deeply and exceeded the map-test child's stack, so it was stopped. The run was not retried. (${exit})`,
    );
  }
  if (code === statusFailFast) {
    return desktopErrorMessage(
      'map-test.child-aborted',
      `The map-test child aborted, most likely at its memory or stack limit. The run was not retried. (${exit})`,
    );
  }
  return desktopErrorMessage('native.exited', exit, { name: 'rms-test' });
}

export function mapTestRunDisplayStreams(
  progressWanted: boolean,
  progressSupported: boolean,
): { progressivePreview: false; sampleProgress: boolean } {
  return { progressivePreview: false, sampleProgress: progressWanted && progressSupported };
}

export class MapTestClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<string, PendingRequest>();
  private stopping = false;
  private sampleProgress = false;
  private automaticWorkers = false;
  private reportRequestRevision = false;
  private stderrTail = '';

  constructor(
    private readonly executablePath: string,
    private readonly onStatus: (status: NativeProcessStatus) => void,
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    this.onStatus({ name: 'rms-test', state: 'starting' });
    const child = spawn(this.executablePath, ['serve'], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.acceptOutput(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-maximumStderrTailCharacters);
      const detail = chunk.trim();
      if (detail && !this.stopping) {
        this.onStatus({ name: 'rms-test', state: 'running', detail });
      }
    });
    guardChildStreams(child, (error) => {
      if (this.child !== child) return;
      if (this.stopping || isClosedPipeError(error)) this.rejectPending(error);
      else this.fail(error);
    });
    child.once('error', (error) => this.fail(error));
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      const error = new Error(describeMapTestChildExit(code, signal, this.stderrTail));
      this.stderrTail = '';
      this.rejectPending(error);
      this.onStatus({
        name: 'rms-test',
        state: this.stopping ? 'stopped' : 'failed',
        detail: this.stopping ? undefined : error.message,
      });
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const response = await this.sendAndWait(
      createEnvelope(`map-test-handshake-${randomUUID()}`, {
        case: 'handshakeRequest',
        value: create(HandshakeRequestSchema, {
          protocolVersion: create(ArtifactVersionSchema, { major: 2, minor: 17, patch: 0 }),
          supportedProtocol: create(CompatibilityRangeSchema, {
            minimumMajor: 2,
            maximumMajor: 2,
          }),
          clientName: 'aoe2-rmside-desktop',
        }),
      }),
      'handshakeResponse',
    );
    if (
      response.payload.case !== 'handshakeResponse' ||
      response.payload.value.protocolVersion?.major !== 2 ||
      response.payload.value.capabilities?.mapTesting !== true
    ) {
      throw new Error('rms-test does not support the required map-testing-v1 capability');
    }
    this.sampleProgress = response.payload.value.capabilities.mapTestProgress;
    this.automaticWorkers = response.payload.value.capabilities.mapTestAutomaticWorkers;
    this.reportRequestRevision = response.payload.value.capabilities.mapTestReportRequestRevision;
    this.onStatus({ name: 'rms-test', state: 'running' });
  }

  async run(
    input: MapTestRunInput,
    sourceCatalogs: readonly MainSourceCatalog[],
    onEvent?: (event: MapTestEvent) => void,
    localContent?: LocalContentSource,
  ): Promise<MapTestRunResult> {
    if (!this.child) {
      throw new DesktopError('native.unavailable', 'rms-test is unavailable', { name: 'rms-test' });
    }
    const startedAt = Date.now();
    const setup = decodeRendererSetupContext(input.modeContext, input.players.length);
    const response = await this.sendAndWait(
      createEnvelope(input.executionId, {
        case: 'mapTestRunRequest',
        value: create(MapTestRunRequestSchema, {
          identity: create(RequestIdentitySchema, {
            requestId: input.executionId,
            documentRevision: BigInt(input.scriptRevision),
          }),
          semanticApiMajor: 2,
          reportRequestRevision: this.reportRequestRevision,
          script: Buffer.from(input.scriptSource, 'utf8'),
          scriptName: input.scriptName,
          workspaceName: input.workspaceName,
          defaultSourcePath: input.defaultSourcePath ?? '',
          sourceCatalogs: sourceCatalogs.map(protocolSourceCatalog),
          profileId: input.profile.profileId,
          contentPackId: input.contentPack.packId,
          width: input.width,
          height: input.height,
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
          ...mapTestWorkerRequest(
            input.workers,
            this.automaticWorkers,
            Math.min(4, availableParallelism()),
          ),
          behaviorProfileHash: fromHex(input.profile.profileHash, 'behavior profile hash'),
          contentPackVersion: input.contentPack.packVersion,
          contentPackHash: fromHex(input.contentPack.contentHash, 'content pack hash'),
          contentSourceFingerprint: input.contentPack.sourceFingerprint,
          ...(localContent ? { localContent: protocolLocalContentSource(localContent) } : {}),
          ...mapTestRunDisplayStreams(onEvent !== undefined, this.sampleProgress),
        }),
      }),
      'mapTestRunResponse',
      onEvent,
      (preview) => toPreviewResult(preview, input, sourceCatalogs, setup.colors),
    );
    if (response.payload.case !== 'mapTestRunResponse') {
      throw new Error('invalid map-test response');
    }
    return toRunResult(
      response.payload.value,
      input,
      sourceCatalogs,
      setup.colors,
      startedAt,
      this.reportRequestRevision,
    );
  }

  async cancel(requestId: string): Promise<boolean> {
    if (!this.child) return false;
    const response = await this.sendAndWait(
      createEnvelope(`map-test-cancel-${randomUUID()}`, {
        case: 'cancellationRequest',
        value: create(CancellationRequestSchema, { requestId }),
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
      await Promise.race([
        this.sendAndWait(
          createEnvelope(`map-test-shutdown-${randomUUID()}`, {
            case: 'shutdownRequest',
            value: create(ShutdownRequestSchema),
          }),
          'shutdownResponse',
        ),
        rejectAfter(1_500, 'rms-test shutdown timed out'),
      ]);
    } catch {
      child.kill();
    } finally {
      child.stdin.end();
    }
    await waitForExit(child, 1_500);
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
    onEvent?: (event: MapTestEvent) => void,
    decodePreview?: (preview: MapTestPreview) => PreviewGenerationResult,
  ): Promise<Envelope> {
    const child = this.child;
    if (!child || child.stdin.destroyed) {
      return Promise.reject(
        new DesktopError('native.unavailable', 'rms-test is not running', { name: 'rms-test' }),
      );
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.requestId, {
        expectedCase,
        lastOutputOrdinal: -1,
        lastPreviewOrdinal: -1,
        lastProgress: { completed: 0, requested: 0 },
        onEvent,
        decodePreview,
        resolve,
        reject,
      });
      child.stdin.write(encodeFrame(toBinary(EnvelopeSchema, message)), (error) => {
        if (!error) return;
        this.pending.delete(message.requestId);
        reject(error);
      });
    });
  }

  private acceptOutput(chunk: Buffer): void {
    try {
      for (const frame of this.decoder.push(chunk)) {
        const message = fromBinary(EnvelopeSchema, frame);
        const pending = this.pending.get(message.requestId);
        if (!pending) continue;
        if (message.payload.case === 'mapTestOutputEvent') {
          const output = message.payload.value;
          if (output.identity?.requestId !== message.requestId) {
            throw new Error('rms-test output identity differs from its envelope');
          }
          if (output.ordinal <= pending.lastOutputOrdinal) {
            throw new Error('rms-test output ordinal is not strictly ordered');
          }
          pending.lastOutputOrdinal = output.ordinal;
          pending.onEvent?.({
            kind: 'output',
            executionId: message.requestId,
            ordinal: output.ordinal,
            text: output.text,
          });
          continue;
        }
        if (message.payload.case === 'mapTestProgressEvent') {
          const progress = message.payload.value;
          const last = pending.lastProgress;
          if (
            progress.identity?.requestId === message.requestId &&
            isMapTestProgressCounts(progress.completedSamples, progress.requestedSamples) &&
            progress.completedSamples >= last.completed &&
            progress.requestedSamples >= last.requested &&
            (progress.completedSamples !== last.completed ||
              progress.requestedSamples !== last.requested)
          ) {
            pending.lastProgress = {
              completed: progress.completedSamples,
              requested: progress.requestedSamples,
            };
            pending.onEvent?.({
              kind: 'progress',
              executionId: message.requestId,
              completed: progress.completedSamples,
              requested: progress.requestedSamples,
            });
          }
          continue;
        }
        if (message.payload.case === 'visualCheckpointEvent') {
          continue;
        }
        if (message.payload.case === 'mapTestPreviewEvent') {
          const event = message.payload.value;
          if (event.identity?.requestId !== message.requestId || !event.preview) {
            throw new Error('rms-test preview identity differs from its envelope');
          }
          if (event.ordinal <= pending.lastPreviewOrdinal) {
            throw new Error('rms-test preview ordinal is not strictly ordered');
          }
          if (!pending.decodePreview) {
            throw new Error('rms-test published an unexpected preview event');
          }
          pending.lastPreviewOrdinal = event.ordinal;
          pending.onEvent?.({
            kind: 'preview',
            executionId: message.requestId,
            ordinal: event.ordinal,
            preview: pending.decodePreview(event.preview),
          });
          continue;
        }
        this.pending.delete(message.requestId);
        if (message.payload.case === 'error') {
          pending.reject(
            new Error(`${message.payload.value.code}: ${message.payload.value.message}`),
          );
        } else if (message.payload.case !== pending.expectedCase) {
          pending.reject(
            new Error(`expected ${pending.expectedCase}, received ${String(message.payload.case)}`),
          );
        } else {
          pending.resolve(message);
        }
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fail(error: Error): void {
    this.rejectPending(error);
    this.onStatus({ name: 'rms-test', state: 'failed', detail: error.message });
    this.child?.kill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function toRunResult(
  response: MapTestRunResponse,
  input: MapTestRunInput,
  sourceCatalogs: readonly MainSourceCatalog[],
  playerColors: readonly number[],
  startedAt: number,
  reportRequestRevision: boolean,
): MapTestRunResult {
  if (
    response.identity?.requestId !== input.executionId ||
    Number(response.identity.documentRevision) !== input.scriptRevision
  ) {
    throw new Error('rms-test response identity is stale');
  }
  const status = protocolStatus(response.status);
  const reportJson = response.reportJson.byteLength
    ? new TextDecoder('utf-8', { fatal: true }).decode(response.reportJson)
    : null;
  const report = reportJson ? validateMapTestReportJson(reportJson) : null;
  if (report && report.schemaVersion !== (reportRequestRevision ? '1.1.0' : '1.0.0')) {
    throw new Error('rms-test report format differs from its negotiated capability');
  }
  if (report && response.reportIdentity.byteLength !== 32) {
    throw new Error('rms-test report identity is invalid');
  }
  if (report && report.reportIdentity !== toHex(response.reportIdentity)) {
    throw new Error('rms-test report identity differs from its envelope');
  }
  return {
    status,
    report,
    reportJson,
    diagnostics: response.diagnostics.map(toDiagnostic),
    preview: response.preview
      ? toPreviewResult(response.preview, input, sourceCatalogs, playerColors)
      : null,
    elapsedMilliseconds: Date.now() - startedAt,
  };
}

export function mapTestPresentationPlayers(
  players: readonly { slot: number; civilizationId: number }[],
  colors: readonly number[],
): { playerColorIds: number[]; playerCivilizationIds: number[] } {
  const playerColorIds = Array.from({ length: 9 }, () => -1);
  const playerCivilizationIds = Array.from({ length: 9 }, () => -1);
  players.forEach((player, index) => {
    playerColorIds[player.slot] = colors[index] ?? player.slot - 1;
    playerCivilizationIds[player.slot] = player.civilizationId;
  });
  return { playerColorIds, playerCivilizationIds };
}

function toPreviewResult(
  preview: MapTestPreview,
  input: MapTestRunInput,
  sourceCatalogs: readonly MainSourceCatalog[],
  colors: readonly number[],
): PreviewGenerationResult {
  const map = preview.mapState;
  const executionCost = toExecutionCostSummary(preview.executionCost);
  const catalog = sourceCatalogs.find(
    (candidate) => catalogRelativePath(candidate) === preview.sourcePath,
  );
  if (
    !map ||
    !catalog ||
    preview.sourceGraphHash.byteLength !== 32 ||
    toHex(preview.sourceGraphHash) !== toHex(catalog.rmsGraphHash)
  ) {
    throw new Error('rms-test preview source identity is stale or unauthorized');
  }
  const tileCount = map.width * map.height;
  const objects = map.objects;
  const connections = map.connections;
  const objectCount = (objects?.idsLe.byteLength ?? 1) / 4;
  const connectionCount = connections?.kinds.byteLength ?? -1;
  if (
    tileCount < 1 ||
    !objects ||
    !connections ||
    preview.requestHash.byteLength !== 32 ||
    preview.mapHash.byteLength !== 32 ||
    map.terrainIdsLe.byteLength !== tileCount * 4 ||
    map.elevations.byteLength !== tileCount * 2 ||
    map.zonesLe.byteLength !== tileCount * 4 ||
    map.landIdsLe.byteLength !== tileCount * 4 ||
    map.cliffEdges.byteLength % 12 !== 0 ||
    !Number.isInteger(objectCount) ||
    objectCount < 0 ||
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
    connectionCount < 0 ||
    connections.startXLe.byteLength !== connectionCount * 2 ||
    connections.startYLe.byteLength !== connectionCount * 2 ||
    connections.endXLe.byteLength !== connectionCount * 2 ||
    connections.endYLe.byteLength !== connectionCount * 2
  ) {
    throw new Error('rms-test returned an invalid generated map');
  }
  const { playerColorIds, playerCivilizationIds } = mapTestPresentationPlayers(
    input.players,
    colors,
  );
  const emptyTileSourceIndices = new Uint8Array(tileCount * 2).fill(0xff);
  const emptyTileOffsets = new Uint8Array(tileCount * 4).fill(0xff);
  const emptyObjectOperations = new Uint8Array(objectCount * 4).fill(0xff);
  const emptyCliffOperations = new Uint8Array((map.cliffEdges.byteLength / 12) * 4).fill(0xff);
  const emptyConnectionOperations = new Uint8Array(connectionCount * 4).fill(0xff);
  const sourceEntry = catalog.sources.find((entry) => entry.normalizedPath === catalog.entryPath);
  const semanticHash = toHex(preview.mapHash);
  return {
    backend: 'exact',
    backendIdentity: 'exact-rms-v1',
    playerColorIds,
    playerCivilizationIds,
    presentationSeed: preview.seed,
    objectNames: input.contentPack.objectNames.map((entry) => ({ ...entry })),
    graphiclessObjectIds: [...(input.contentPack.graphiclessObjectIds ?? [])],
    mapIconArtObjects: mapIconArtObjectDescriptors(input.contentPack),
    terrainNames: [],
    ...constantNamesFor(input.contentPack),
    minimapPalette: input.minimapPalette ? structuredClone(input.minimapPalette) : null,
    ...(input.texturePalette ? { texturePalette: structuredClone(input.texturePalette) } : {}),
    documentUri: sourceEntry?.sourceId ?? input.defaultSourceUri ?? input.scriptUri,
    documentRevision: sourceEntry?.bufferRevision ?? 0,
    semanticProgramHash: toHex(catalog.rmsGraphHash),
    width: map.width,
    height: map.height,
    terrainIdsLe: Uint8Array.from(map.terrainIdsLe),
    preConnectionTerrainIdsLe:
      map.preConnectionTerrainIdsLe.byteLength === tileCount * 4
        ? Uint8Array.from(map.preConnectionTerrainIdsLe)
        : Uint8Array.from(map.terrainIdsLe),
    elevations: Uint8Array.from(map.elevations),
    terrainZonesLe: Uint8Array.from(map.zonesLe),
    landIdsLe: Uint8Array.from(map.landIdsLe),
    cliffEdges: Uint8Array.from(map.cliffEdges),
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
    sourceIds: [],
    tileSourceIndicesLe: emptyTileSourceIndices,
    tileByteStartsLe: emptyTileOffsets,
    tileByteEndsLe: emptyTileOffsets.slice(),
    provenanceOperations: [],
    provenanceStatus: 'exact',
    tileOperationIndicesLe: emptyTileOffsets.slice(),
    objectOperationIndicesLe: emptyObjectOperations,
    cliffOperationIndicesLe: emptyCliffOperations,
    connectionOperationIndicesLe: emptyConnectionOperations,
    semanticHash,
    requestHash: toHex(preview.requestHash),
    sourceCatalogRevision: catalog.revision,
    sourceCatalogHash: toHex(catalog.catalogHash),
    sourceGraphHash: toHex(catalog.rmsGraphHash),
    externalAssetHash: toHex(catalog.externalAssetHash),
    resolvedRmsSourceIds: catalog.sources
      .filter((entry) => entry.role !== 'external-xs')
      .map((entry) => entry.sourceId),
    externalAssetSourceIds: catalog.sources
      .filter((entry) => entry.role === 'external-xs')
      .map((entry) => entry.sourceId),
    stageHashes: [],
    warnings: [],
    metrics: {},
    ...(executionCost ? { executionCost } : {}),
    generationEvents: [],
    traceIdentity: {
      profileId: input.profile.profileId,
      profileHash: input.profile.profileHash,
      contentPackId: input.contentPack.packId,
      contentPackVersion: input.contentPack.packVersion,
      contentPackHash: input.contentPack.contentHash,
      traceLevel: 'off',
    },
  };
}

function catalogRelativePath(catalog: MainSourceCatalog): string {
  for (const root of catalog.roots.openedOrConfigured) {
    const prefix = `${root}/`;
    if (catalog.entryPath.startsWith(prefix)) return catalog.entryPath.slice(prefix.length);
  }
  return catalog.entryPath;
}

function toDiagnostic(value: MapTestRunResponse['diagnostics'][number]): LanguageServerDiagnostic {
  return {
    range: {
      start: {
        line: Math.max(0, (value.range?.start?.line ?? 1) - 1),
        character: Math.max(0, (value.range?.start?.utf16Column ?? 1) - 1),
      },
      end: {
        line: Math.max(0, (value.range?.end?.line ?? 1) - 1),
        character: Math.max(1, value.range?.end?.utf16Column ?? 1),
      },
    },
    severity: value.severity,
    code: value.code,
    message: value.message,
  };
}

function protocolStatus(status: MapTestStatus): MapTestRunResult['status'] {
  switch (status) {
    case MapTestStatus.PASSED:
      return 'passed';
    case MapTestStatus.FAILED:
      return 'failed';
    case MapTestStatus.ERROR:
      return 'error';
    case MapTestStatus.CANCELLED:
      return 'cancelled';
    default:
      throw new Error('rms-test returned an unsupported status');
  }
}

function fromHex(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} is invalid`);
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

function rejectAfter(milliseconds: number, message: string): Promise<never> {
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
