import type {
  PreviewCliffMutation,
  PreviewConnectionMutation,
  PreviewGenerationEvent,
  PreviewGenerationResult,
  PreviewObjectMutation,
  PreviewProvenanceOperation,
} from '../shared/api';

const maximumTiles = 512 * 512;
const maximumObjects = 1_000_000;
const orderedStages = ['setup', 'land', 'terrain', 'objects', 'finalize'] as const;

export interface PreviewCandidateMap {
  requestId: string;
  width: number;
  height: number;
  backendIdentity: string;
  semanticProgramHash: string;
  requestHash: string;
  provenanceOperations: PreviewProvenanceOperation[];
  terrainIds: Uint32Array;
  elevations: Int16Array;
  terrainZones: Uint32Array;
  landIds: Uint32Array;
  layerIds: Uint16Array;
  flags: Uint32Array;
  tileOperationIndices: Uint32Array;
  tilePresence: Uint8Array;
  objects: Map<number, PreviewObjectMutation>;
  cliffs: Map<number, PreviewCliffMutation>;
  connections: Map<number, PreviewConnectionMutation>;
  stageHashes: { stage: string; hash: string }[];
  events: PreviewGenerationEvent[];
  lastSequence: number;
  terminal: 'active' | 'completed' | 'cancelled' | 'failed';
}

export interface ReconstructedPreviewState {
  width: number;
  height: number;
  terrainIdsLe: Uint8Array;
  elevations: Uint8Array;
  terrainZonesLe: Uint8Array;
  landIdsLe: Uint8Array;
  layerIdsLe: Uint8Array;
  flagsLe: Uint8Array;
  tileOperationIndicesLe: Uint8Array;
  tilePresence: Uint8Array;
  objects: PreviewObjectMutation[];
  cliffs: PreviewCliffMutation[];
  connections: PreviewConnectionMutation[];
  provenanceOperations: PreviewProvenanceOperation[];
  semanticHash: string;
  stageHashes: { stage: string; hash: string }[];
}

export function createPreviewCandidate(event: PreviewGenerationEvent): PreviewCandidateMap {
  const initialization = event.initialization;
  if (event.kind !== 'generation-started' || event.sequence !== 0 || !initialization) {
    throw new Error('candidate stream must begin with initialized GenerationStarted');
  }
  const tileCount = initialization.width * initialization.height;
  if (
    !Number.isSafeInteger(tileCount) ||
    tileCount < 1 ||
    tileCount > maximumTiles ||
    !/^[0-9a-f]{64}$/u.test(initialization.semanticProgramHash) ||
    !/^[0-9a-f]{64}$/u.test(initialization.requestHash)
  ) {
    throw new Error('candidate initialization is invalid');
  }
  return {
    requestId: event.requestId,
    width: initialization.width,
    height: initialization.height,
    backendIdentity: initialization.backendIdentity,
    semanticProgramHash: initialization.semanticProgramHash,
    requestHash: initialization.requestHash,
    provenanceOperations: structuredClone(initialization.provenanceOperations),
    terrainIds: new Uint32Array(tileCount),
    elevations: new Int16Array(tileCount),
    terrainZones: new Uint32Array(tileCount),
    landIds: new Uint32Array(tileCount),
    layerIds: new Uint16Array(tileCount),
    flags: new Uint32Array(tileCount),
    tileOperationIndices: new Uint32Array(tileCount).fill(0xffff_ffff),
    tilePresence: new Uint8Array(tileCount),
    objects: new Map(),
    cliffs: new Map(),
    connections: new Map(),
    stageHashes: [],
    events: [structuredClone(event)],
    lastSequence: 0,
    terminal: 'active',
  };
}

export function applyPreviewGenerationEvent(
  candidate: PreviewCandidateMap,
  event: PreviewGenerationEvent,
): void {
  if (candidate.terminal !== 'active') throw new Error('candidate stream is already terminal');
  if (event.requestId !== candidate.requestId || event.sequence <= candidate.lastSequence) {
    throw new Error('candidate event identity or sequence is invalid');
  }
  if (event.initialization) throw new Error('candidate initialization may appear only once');
  if (event.kind === 'delta-batch') {
    if (!event.delta) throw new Error('DeltaBatch requires typed mutations');
    applyDelta(candidate, event.delta);
  } else if (event.delta) {
    throw new Error('typed mutations are allowed only on DeltaBatch');
  }
  if (event.kind === 'stage-completed') {
    if (!event.stateHash || candidate.stageHashes.some((value) => value.stage === event.stage)) {
      throw new Error('stage completion hash is missing or duplicated');
    }
    candidate.stageHashes.push({ stage: event.stage, hash: event.stateHash });
  }
  if (event.kind === 'generation-completed') candidate.terminal = 'completed';
  if (event.kind === 'cancelled') candidate.terminal = 'cancelled';
  if (event.kind === 'failed') candidate.terminal = 'failed';
  candidate.lastSequence = event.sequence;
  candidate.events.push(structuredClone(event));
}

export function discardPreviewCandidate(candidate: PreviewCandidateMap): void {
  candidate.terminal = 'cancelled';
  candidate.objects.clear();
  candidate.cliffs.clear();
  candidate.connections.clear();
  candidate.tilePresence.fill(0);
}

export async function reconstructPreviewEvents(
  events: PreviewGenerationEvent[],
  cursor = events.length - 1,
  verifyHashes = true,
): Promise<ReconstructedPreviewState> {
  if (events.length < 1 || events.length > 8192) {
    throw new Error('generation event collection is outside its bounds');
  }
  const candidate = createPreviewCandidate(events[0]!);
  const finalCursor = Math.max(0, Math.min(events.length - 1, Math.trunc(cursor)));
  for (let index = 1; index <= finalCursor; index += 1) {
    const event = events[index]!;
    applyPreviewGenerationEvent(candidate, event);
    if (verifyHashes && event.kind === 'stage-completed') {
      const actual = await stageSemanticHash(event.stage, candidate);
      if (actual !== event.stateHash) throw new Error(`stage hash mismatch for ${event.stage}`);
    }
  }
  const semanticHash = await candidateSemanticHash(candidate);
  if (verifyHashes && candidate.terminal === 'completed') {
    const terminal = candidate.events.at(-1)!;
    if (terminal.stateHash !== semanticHash) {
      throw new Error('generation final hash does not match reconstructed state');
    }
    validateCompleteCandidate(candidate);
  }
  return materializeCandidate(candidate, semanticHash);
}

export function reconstructPreviewEventsAtCursor(
  events: PreviewGenerationEvent[],
  cursor: number,
): ReconstructedPreviewState {
  if (events.length < 1 || events.length > 8192) {
    throw new Error('generation event collection is outside its bounds');
  }
  const candidate = createPreviewCandidate(events[0]!);
  const finalCursor = Math.max(0, Math.min(events.length - 1, Math.trunc(cursor)));
  for (let index = 1; index <= finalCursor; index += 1) {
    applyPreviewGenerationEvent(candidate, events[index]!);
  }
  return materializeCandidate(
    candidate,
    candidate.events.at(-1)?.stateHash ?? candidate.requestHash,
  );
}

export async function semanticHashAtEventCursor(
  events: PreviewGenerationEvent[],
  cursor: number,
): Promise<string> {
  const candidate = candidateAtCursor(events, cursor);
  return candidateSemanticHash(candidate);
}

export async function stageHashAtEventCursor(
  events: PreviewGenerationEvent[],
  cursor: number,
  stage: string,
): Promise<string> {
  const candidate = candidateAtCursor(events, cursor);
  return stageSemanticHash(stage, candidate);
}

export function reconstructedPreviewResult(
  state: ReconstructedPreviewState,
  template: PreviewGenerationResult,
): PreviewGenerationResult {
  const sourceIds: string[] = [];
  for (const operation of state.provenanceOperations) {
    if (!sourceIds.includes(operation.sourceId)) sourceIds.push(operation.sourceId);
  }
  if (sourceIds.length === 0) sourceIds.push(template.documentUri);
  const tileOperations = u32View(state.tileOperationIndicesLe);
  const tileSourceIndices = new Uint16Array(tileOperations.length);
  const tileByteStarts = new Uint32Array(tileOperations.length);
  const tileByteEnds = new Uint32Array(tileOperations.length);
  tileOperations.forEach((operationIndex, tileIndex) => {
    const operation = state.provenanceOperations[operationIndex];
    if (!operation) return;
    tileSourceIndices[tileIndex] = Math.max(0, sourceIds.indexOf(operation.sourceId));
    tileByteStarts[tileIndex] = operation.byteStart;
    tileByteEnds[tileIndex] = operation.byteEnd;
  });
  const objectOperationIndices = new Uint32Array(
    state.objects.map((value) => value.provenanceOperationIndex),
  );
  const cliffOperationIndices = new Uint32Array(
    state.cliffs.map((value) => value.provenanceOperationIndex),
  );
  const connectionOperationIndices = new Uint32Array(
    state.connections.map((value) => value.provenanceOperationIndex),
  );
  return {
    ...template,
    width: state.width,
    height: state.height,
    terrainIdsLe: state.terrainIdsLe,
    elevations: state.elevations,
    terrainZonesLe: state.terrainZonesLe,
    landIdsLe: state.landIdsLe,
    layerIdsLe: state.layerIdsLe,
    flagsLe: state.flagsLe,
    cliffEdges: encodeCliffs(state.cliffs),
    objects: encodeObjects(state.objects, template.objects),
    connections: encodeConnections(state.connections),
    sourceIds,
    tileSourceIndicesLe: bytesOf(tileSourceIndices),
    tileByteStartsLe: bytesOf(tileByteStarts),
    tileByteEndsLe: bytesOf(tileByteEnds),
    provenanceOperations: state.provenanceOperations,
    tileOperationIndicesLe: state.tileOperationIndicesLe,
    objectOperationIndicesLe: bytesOf(objectOperationIndices),
    cliffOperationIndicesLe: bytesOf(cliffOperationIndices),
    connectionOperationIndicesLe: bytesOf(connectionOperationIndices),
    semanticHash: state.semanticHash,
    stageHashes: state.stageHashes,
  };
}

export async function assertStreamMatchesResult(result: PreviewGenerationResult): Promise<void> {
  const events = result.generationEvents;
  if (events.length < 2 || events.length > 8192) {
    throw new Error('generation event collection is outside its bounds');
  }
  const first = events[0];
  const initialization = first?.initialization;
  if (
    first?.kind !== 'generation-started' ||
    first.sequence !== 0 ||
    !initialization ||
    initialization.width !== result.width ||
    initialization.height !== result.height ||
    initialization.backendIdentity !== result.backendIdentity ||
    initialization.requestHash !== result.requestHash ||
    JSON.stringify(initialization.provenanceOperations) !==
      JSON.stringify(result.provenanceOperations)
  ) {
    throw new Error('stream initialization identity differs from the final result');
  }
  let previousSequence = -1;
  for (const [index, event] of events.entries()) {
    if (
      event.requestId !== first.requestId ||
      event.sequence <= previousSequence ||
      (index > 0 && event.initialization)
    ) {
      throw new Error('stream event identity or sequence is invalid');
    }
    previousSequence = event.sequence;
  }
  const terminal = events.at(-1)!;
  if (terminal.kind !== 'generation-completed' || terminal.stateHash !== result.semanticHash) {
    throw new Error('stream completion identity differs from the final result');
  }
  const streamedStageHashes = events
    .filter((event) => event.kind === 'stage-completed')
    .map((event) => {
      if (!event.stateHash) throw new Error(`stage hash is missing for ${event.stage}`);
      return { stage: event.stage, hash: event.stateHash };
    });
  if (JSON.stringify(streamedStageHashes) !== JSON.stringify(result.stageHashes)) {
    throw new Error('stream stage hashes differ from final result');
  }
  const hasMutations = events.some((event) => event.kind === 'delta-batch');
  if (!hasMutations) {
    if (result.traceIdentity.traceLevel === 'full') {
      throw new Error('full trace stream contains no reconstructive mutations');
    }
    return;
  }
  const reconstructed = await reconstructPreviewEvents(events);
  if (reconstructed.semanticHash !== result.semanticHash) {
    throw new Error('stream reconstruction hash differs from the final result');
  }
  const materialized = reconstructedPreviewResult(reconstructed, result);
  for (const [name, left, right] of [
    ['terrain', reconstructed.terrainIdsLe, result.terrainIdsLe],
    ['elevation', reconstructed.elevations, result.elevations],
    ['terrain-zone', reconstructed.terrainZonesLe, result.terrainZonesLe],
    ['land', reconstructed.landIdsLe, result.landIdsLe],
    ['layer', reconstructed.layerIdsLe, result.layerIdsLe],
    ['flags', reconstructed.flagsLe, result.flagsLe],
    ['tile provenance', reconstructed.tileOperationIndicesLe, result.tileOperationIndicesLe],
    ['tile source', materialized.tileSourceIndicesLe, result.tileSourceIndicesLe],
    ['tile source start', materialized.tileByteStartsLe, result.tileByteStartsLe],
    ['tile source end', materialized.tileByteEndsLe, result.tileByteEndsLe],
    ['object provenance', materialized.objectOperationIndicesLe, result.objectOperationIndicesLe],
    ['cliff provenance', materialized.cliffOperationIndicesLe, result.cliffOperationIndicesLe],
    [
      'connection provenance',
      materialized.connectionOperationIndicesLe,
      result.connectionOperationIndicesLe,
    ],
  ] as const) {
    if (!equalBytes(left, right)) throw new Error(`${name} stream state differs from final result`);
  }
  const finalObjects = resultObjects(result);
  const finalCliffs = resultCliffs(result);
  const finalConnections = resultConnections(result);
  if (
    JSON.stringify(materialized.sourceIds) !== JSON.stringify(result.sourceIds) ||
    JSON.stringify(reconstructed.objects) !== JSON.stringify(finalObjects) ||
    JSON.stringify(reconstructed.cliffs) !== JSON.stringify(finalCliffs) ||
    JSON.stringify(reconstructed.connections) !== JSON.stringify(finalConnections)
  ) {
    throw new Error('foreground stream state differs from final result');
  }
}

function applyDelta(
  candidate: PreviewCandidateMap,
  delta: NonNullable<PreviewGenerationEvent['delta']>,
): void {
  if (
    delta.tiles.length > 1024 ||
    delta.objects.length > 256 ||
    delta.cliffs.length > 256 ||
    delta.connections.length > 256
  ) {
    throw new Error('generation mutation batch exceeds its bounds');
  }
  for (const mutation of delta.tiles) {
    const index = mutation.tileIndex;
    if (!Number.isSafeInteger(index) || index < 0 || index >= candidate.terrainIds.length) {
      throw new Error('tile mutation index is outside the candidate map');
    }
    if (mutation.operation === 'remove') {
      candidate.tilePresence[index] = 0;
      candidate.tileOperationIndices[index] = 0xffff_ffff;
      continue;
    }
    candidate.terrainIds[index] = mutation.terrainId;
    candidate.elevations[index] = mutation.elevation;
    candidate.terrainZones[index] = mutation.terrainZone;
    candidate.landIds[index] = mutation.landId;
    candidate.layerIds[index] = mutation.layerId;
    candidate.flags[index] = mutation.flags;
    candidate.tileOperationIndices[index] = mutation.provenanceOperationIndex;
    candidate.tilePresence[index] = 1;
  }
  for (const object of delta.objects) {
    if (
      !Number.isInteger(object.resourceType) ||
      object.resourceType < -32768 ||
      object.resourceType > 32767 ||
      !Number.isInteger(object.resourceQuantityF32Bits) ||
      object.resourceQuantityF32Bits < 0 ||
      object.resourceQuantityF32Bits > 0xffff_ffff
    )
      throw new Error('object resource state is outside its fixed-width contract');
  }
  applyIndexedMutations(candidate.objects, delta.objects, 'objectIndex', maximumObjects);
  applyIndexedMutations(
    candidate.cliffs,
    delta.cliffs,
    'cliffIndex',
    candidate.terrainIds.length * 8,
  );
  applyIndexedMutations(
    candidate.connections,
    delta.connections,
    'connectionIndex',
    candidate.terrainIds.length * 8,
  );
}

function candidateAtCursor(events: PreviewGenerationEvent[], cursor: number): PreviewCandidateMap {
  const candidate = createPreviewCandidate(events[0]!);
  const finalCursor = Math.max(0, Math.min(events.length - 1, Math.trunc(cursor)));
  for (let index = 1; index <= finalCursor; index += 1) {
    applyPreviewGenerationEvent(candidate, events[index]!);
  }
  return candidate;
}

function applyIndexedMutations<T extends { operation: 'replace' | 'remove' }>(
  target: Map<number, T>,
  mutations: T[],
  indexKey: keyof T,
  maximum: number,
): void {
  for (const mutation of mutations) {
    const index = mutation[indexKey];
    if (
      typeof index !== 'number' ||
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= maximum
    ) {
      throw new Error('foreground mutation index is outside its bounds');
    }
    if (mutation.operation === 'remove') target.delete(index);
    else target.set(index, structuredClone(mutation));
  }
}

function validateCompleteCandidate(candidate: PreviewCandidateMap): void {
  if (candidate.tilePresence.some((value) => value !== 1)) {
    throw new Error('completed generation stream did not define every tile');
  }
  for (const collection of [candidate.objects, candidate.cliffs, candidate.connections]) {
    const indices = [...collection.keys()].sort((left, right) => left - right);
    if (indices.some((value, index) => value !== index)) {
      throw new Error('completed foreground mutation indices are not contiguous');
    }
  }
  if (
    candidate.stageHashes.length !== orderedStages.length ||
    candidate.stageHashes.some((value, index) => value.stage !== orderedStages[index])
  ) {
    throw new Error('completed generation stream has incomplete stage hashes');
  }
}

async function candidateSemanticHash(candidate: PreviewCandidateMap): Promise<string> {
  return sha256Hex(canonicalCandidateBytes(candidate));
}

async function stageSemanticHash(stage: string, candidate: PreviewCandidateMap): Promise<string> {
  const stateHash = await candidateSemanticHash(candidate);
  return sha256Hex(concatBytes(utf8('rms-generated-stage-v2'), utf8(stage), fromHex(stateHash)));
}

function canonicalCandidateBytes(candidate: PreviewCandidateMap): Uint8Array {
  const writer = new CanonicalWriter();
  writer.string('rms-generated-map-v3');
  writer.u16(candidate.width);
  writer.u16(candidate.height);
  writer.u32(candidate.terrainIds.length);
  for (const value of candidate.terrainIds) writer.u32(value);
  for (const value of candidate.layerIds) writer.u16(value);
  for (const value of candidate.elevations) writer.i16(value);
  for (const value of candidate.landIds) writer.u32(value);
  for (const value of candidate.terrainZones) writer.u32(value);
  for (const value of candidate.flags) writer.u32(value);
  const cliffs = orderedValues(candidate.cliffs);
  writer.u32(cliffs.length);
  for (const value of cliffs) {
    writer.u16(value.fromX);
    writer.u16(value.fromY);
    writer.u16(value.toX);
    writer.u16(value.toY);
    writer.u32(value.cliffType);
  }
  const connections = orderedValues(candidate.connections);
  writer.u32(connections.length);
  for (const value of connections) {
    writer.u16(value.startX);
    writer.u16(value.startY);
    writer.u16(value.endX);
    writer.u16(value.endY);
    writer.u8(value.kind);
  }
  const objects = orderedValues(candidate.objects);
  writer.u32(objects.length);
  for (const value of objects) {
    writer.u32(value.objectId);
    writer.u32(value.x256);
    writer.u32(value.y256);
    writer.u8(value.owner);
    writer.u16(value.facet);
    writer.u16(value.footprintWidth256);
    writer.u16(value.footprintHeight256);
    writer.u8(value.presentationKind);
    writer.u16(value.resourceType);
    writer.u32(value.resourceQuantityF32Bits);
  }
  return writer.finish();
}

function materializeCandidate(
  candidate: PreviewCandidateMap,
  semanticHash: string,
): ReconstructedPreviewState {
  return {
    width: candidate.width,
    height: candidate.height,
    terrainIdsLe: bytesOf(candidate.terrainIds),
    elevations: bytesOf(candidate.elevations),
    terrainZonesLe: bytesOf(candidate.terrainZones),
    landIdsLe: bytesOf(candidate.landIds),
    layerIdsLe: bytesOf(candidate.layerIds),
    flagsLe: bytesOf(candidate.flags),
    tileOperationIndicesLe: bytesOf(candidate.tileOperationIndices),
    tilePresence: Uint8Array.from(candidate.tilePresence),
    objects: orderedValues(candidate.objects),
    cliffs: orderedValues(candidate.cliffs),
    connections: orderedValues(candidate.connections),
    provenanceOperations: structuredClone(candidate.provenanceOperations),
    semanticHash,
    stageHashes: structuredClone(candidate.stageHashes),
  };
}

function resultObjects(result: PreviewGenerationResult): PreviewObjectMutation[] {
  const count = result.objects.idsLe.byteLength / 4;
  const ids = u32View(result.objects.idsLe);
  const x = u32View(result.objects.xLe);
  const y = u32View(result.objects.yLe);
  const facets = u16View(result.objects.facetsLe);
  const widths = u16View(result.objects.footprintWidths256Le);
  const heights = u16View(result.objects.footprintHeights256Le);
  const resourceTypes = new DataView(
    result.objects.resourceTypeLe.buffer,
    result.objects.resourceTypeLe.byteOffset,
    result.objects.resourceTypeLe.byteLength,
  );
  const resourceQuantities = u32View(result.objects.resourceQuantityF32BitsLe);
  const operations = u32View(result.objectOperationIndicesLe);
  return Array.from({ length: count }, (_, objectIndex) => ({
    objectIndex,
    objectId: ids[objectIndex]!,
    x256: x[objectIndex]!,
    y256: y[objectIndex]!,
    owner: result.objects.owners[objectIndex]!,
    facet: facets[objectIndex]!,
    footprintWidth256: widths[objectIndex]!,
    footprintHeight256: heights[objectIndex]!,
    presentationKind: result.objects.presentationKinds[objectIndex]!,
    resourceType: resourceTypes.getInt16(objectIndex * 2, true),
    resourceQuantityF32Bits: resourceQuantities[objectIndex]!,
    operation: 'replace',
    provenanceOperationIndex: operations[objectIndex]!,
  }));
}

function resultCliffs(result: PreviewGenerationResult): PreviewCliffMutation[] {
  const view = new DataView(result.cliffEdges.buffer, result.cliffEdges.byteOffset);
  const operations = u32View(result.cliffOperationIndicesLe);
  return Array.from({ length: result.cliffEdges.byteLength / 12 }, (_, cliffIndex) => {
    const offset = cliffIndex * 12;
    return {
      cliffIndex,
      fromX: view.getUint16(offset, true),
      fromY: view.getUint16(offset + 2, true),
      toX: view.getUint16(offset + 4, true),
      toY: view.getUint16(offset + 6, true),
      cliffType: view.getUint32(offset + 8, true),
      operation: 'replace',
      provenanceOperationIndex: operations[cliffIndex]!,
    };
  });
}

function resultConnections(result: PreviewGenerationResult): PreviewConnectionMutation[] {
  const startX = u16View(result.connections.startXLe);
  const startY = u16View(result.connections.startYLe);
  const endX = u16View(result.connections.endXLe);
  const endY = u16View(result.connections.endYLe);
  const operations = u32View(result.connectionOperationIndicesLe);
  return Array.from({ length: result.connections.kinds.length }, (_, connectionIndex) => ({
    connectionIndex,
    startX: startX[connectionIndex]!,
    startY: startY[connectionIndex]!,
    endX: endX[connectionIndex]!,
    endY: endY[connectionIndex]!,
    kind: result.connections.kinds[connectionIndex]!,
    operation: 'replace',
    provenanceOperationIndex: operations[connectionIndex]!,
  }));
}

function encodeObjects(
  values: PreviewObjectMutation[],
  template?: PreviewGenerationResult['objects'],
): PreviewGenerationResult['objects'] {
  const ids = new Uint32Array(values.map((value) => value.objectId));
  const x = new Uint32Array(values.map((value) => value.x256));
  const y = new Uint32Array(values.map((value) => value.y256));
  const facets = new Uint16Array(values.map((value) => value.facet));
  const widths = new Uint16Array(values.map((value) => value.footprintWidth256));
  const heights = new Uint16Array(values.map((value) => value.footprintHeight256));
  const base = {
    idsLe: bytesOf(ids),
    xLe: bytesOf(x),
    yLe: bytesOf(y),
    owners: Uint8Array.from(values, (value) => value.owner),
    facetsLe: bytesOf(facets),
    footprintWidths256Le: bytesOf(widths),
    footprintHeights256Le: bytesOf(heights),
    presentationKinds: Uint8Array.from(values, (value) => value.presentationKind),
  };
  const preservesTemplateDetails =
    template !== undefined &&
    equalBytes(base.idsLe, template.idsLe) &&
    equalBytes(base.xLe, template.xLe) &&
    equalBytes(base.yLe, template.yLe) &&
    equalBytes(base.owners, template.owners) &&
    equalBytes(base.facetsLe, template.facetsLe) &&
    equalBytes(base.footprintWidths256Le, template.footprintWidths256Le) &&
    equalBytes(base.footprintHeights256Le, template.footprintHeights256Le) &&
    equalBytes(base.presentationKinds, template.presentationKinds);
  return {
    ...base,
    resourceTypeLe: bytesOf(new Int16Array(values.map((value) => value.resourceType))),
    resourceQuantityF32BitsLe: bytesOf(
      new Uint32Array(values.map((value) => value.resourceQuantityF32Bits)),
    ),
    resourceDeltasLe: preservesTemplateDetails
      ? Uint8Array.from(template.resourceDeltasLe)
      : new Uint8Array(values.length * 4),
    statusesLe: preservesTemplateDetails
      ? Uint8Array.from(template.statusesLe)
      : new Uint8Array(values.length * 4),
    deathStates: preservesTemplateDetails
      ? Uint8Array.from(template.deathStates)
      : new Uint8Array(values.length),
    dataStatusesLe: preservesTemplateDetails
      ? Uint8Array.from(template.dataStatusesLe)
      : new Uint8Array(values.length * 2),
    selectionFlags: preservesTemplateDetails
      ? Uint8Array.from(template.selectionFlags)
      : new Uint8Array(values.length),
    behaviorFlagsLe: preservesTemplateDetails
      ? Uint8Array.from(template.behaviorFlagsLe)
      : new Uint8Array(values.length * 2),
  };
}

function encodeCliffs(values: PreviewCliffMutation[]): Uint8Array {
  const result = new Uint8Array(values.length * 12);
  const view = new DataView(result.buffer);
  values.forEach((value, index) => {
    const offset = index * 12;
    view.setUint16(offset, value.fromX, true);
    view.setUint16(offset + 2, value.fromY, true);
    view.setUint16(offset + 4, value.toX, true);
    view.setUint16(offset + 6, value.toY, true);
    view.setUint32(offset + 8, value.cliffType, true);
  });
  return result;
}

function encodeConnections(
  values: PreviewConnectionMutation[],
): PreviewGenerationResult['connections'] {
  return {
    startXLe: bytesOf(new Uint16Array(values.map((value) => value.startX))),
    startYLe: bytesOf(new Uint16Array(values.map((value) => value.startY))),
    endXLe: bytesOf(new Uint16Array(values.map((value) => value.endX))),
    endYLe: bytesOf(new Uint16Array(values.map((value) => value.endY))),
    kinds: Uint8Array.from(values, (value) => value.kind),
  };
}

class CanonicalWriter {
  private readonly bytes: number[] = [];

  u8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  u16(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
  }

  i16(value: number): void {
    this.u16(value & 0xffff);
  }

  u32(value: number): void {
    this.u8(value);
    this.u8(value >>> 8);
    this.u8(value >>> 16);
    this.u8(value >>> 24);
  }

  string(value: string): void {
    const bytes = utf8(value);
    this.u32(bytes.length);
    this.bytes.push(...bytes);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

function orderedValues<T>(values: Map<number, T>): T[] {
  return [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => structuredClone(value));
}

function bytesOf(value: Uint16Array | Int16Array | Uint32Array): Uint8Array {
  return new Uint8Array(value.buffer.slice(0));
}

function u16View(bytes: Uint8Array): Uint16Array {
  return new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function u32View(bytes: Uint8Array): Uint32Array {
  return new Uint32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error('hash is invalid');
  return Uint8Array.from(value.match(/../gu)!, (byte) => Number.parseInt(byte, 16));
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const input = value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
  const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', input));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
