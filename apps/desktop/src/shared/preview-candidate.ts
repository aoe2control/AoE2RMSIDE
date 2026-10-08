export const previewCandidateContractMajor = 1;
export const previewCandidateChunkTiles = 32;
export const maximumPreviewCandidateDimension = 512;
export const maximumPreviewCandidateChunks = 256;
export const maximumPreviewCandidateBytes = 8 * 1024 * 1024;
export const maximumPreviewCandidateObjects = 262_144;
export const maximumPreviewCandidateCliffs = 262_144;
export const previewCandidateObjectRecordBytes = 18;
export const previewCandidateCliffRecordBytes = 12;
export const maximumPreviewCandidateRevision = 2 ** 40;

export const previewCandidateStages = [
  'land',
  'elevation',
  'cliffs',
  'terrain',
  'connections',
  'objects',
  'sample-complete',
] as const;
export type PreviewCandidateStage = (typeof previewCandidateStages)[number];

export interface PreviewCandidateChunk {
  chunkX: number;
  chunkY: number;
  terrainIdsLe: Uint8Array;
  elevations: Uint8Array;
  cliffEdges: Uint8Array;
  objects: Uint8Array;
}

export interface PreviewCandidateSample {
  ordinal: number;
  seed: number;
}

export interface PreviewCandidate {
  requestId: string;
  revision: number;
  baseRevision: number;
  stage: PreviewCandidateStage;
  width: number;
  height: number;
  elapsedUs: number;
  sample?: PreviewCandidateSample;
  chunks: PreviewCandidateChunk[];
}

export interface PreviewCandidateAcknowledgement {
  requestId: string;
  revision: number;
  accepted: boolean;
}

export function previewCandidateChunkGrid(
  width: number,
  height: number,
): { columns: number; rows: number } {
  return {
    columns: Math.ceil(width / previewCandidateChunkTiles),
    rows: Math.ceil(height / previewCandidateChunkTiles),
  };
}

export function previewCandidateChunkBounds(
  width: number,
  height: number,
  chunkX: number,
  chunkY: number,
): { minimumX: number; maximumX: number; minimumY: number; maximumY: number } {
  const minimumX = chunkX * previewCandidateChunkTiles;
  const minimumY = chunkY * previewCandidateChunkTiles;
  return {
    minimumX,
    minimumY,
    maximumX: Math.min(width, minimumX + previewCandidateChunkTiles) - 1,
    maximumY: Math.min(height, minimumY + previewCandidateChunkTiles) - 1,
  };
}

export function previewCandidateChunkTileCount(
  width: number,
  height: number,
  chunkX: number,
  chunkY: number,
): number {
  const bounds = previewCandidateChunkBounds(width, height, chunkX, chunkY);
  return (
    Math.max(0, bounds.maximumX - bounds.minimumX + 1) *
    Math.max(0, bounds.maximumY - bounds.minimumY + 1)
  );
}

export function previewCandidateBytes(candidate: Pick<PreviewCandidate, 'chunks'>): number {
  let bytes = 0;
  for (const chunk of candidate.chunks) {
    bytes +=
      chunk.terrainIdsLe.byteLength +
      chunk.elevations.byteLength +
      chunk.cliffEdges.byteLength +
      chunk.objects.byteLength;
  }
  return bytes;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= maximum
  );
}

export function validatePreviewCandidate(value: unknown): PreviewCandidate {
  const record = value as Partial<PreviewCandidate> | null | undefined;
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.requestId !== 'string' ||
    record.requestId.length < 1 ||
    record.requestId.length > 512 ||
    !isBoundedInteger(record.revision, 1, maximumPreviewCandidateRevision) ||
    !isBoundedInteger(record.baseRevision, 0, record.revision - 1) ||
    !previewCandidateStages.includes(record.stage as PreviewCandidateStage) ||
    !isBoundedInteger(record.width, 1, maximumPreviewCandidateDimension) ||
    !isBoundedInteger(record.height, 1, maximumPreviewCandidateDimension) ||
    !isBoundedInteger(record.elapsedUs, 0, Number.MAX_SAFE_INTEGER) ||
    !Array.isArray(record.chunks)
  ) {
    throw new Error('preview candidate is malformed');
  }
  const { columns, rows } = previewCandidateChunkGrid(record.width, record.height);
  if (
    record.chunks.length > maximumPreviewCandidateChunks ||
    record.chunks.length > columns * rows ||
    (record.baseRevision === 0 && record.chunks.length !== columns * rows)
  ) {
    throw new Error('preview candidate chunk count is out of bounds');
  }
  if (
    record.sample !== undefined &&
    (!record.sample ||
      typeof record.sample !== 'object' ||
      !isBoundedInteger(record.sample.ordinal, 0, 0xffff_ffff) ||
      !isBoundedInteger(record.sample.seed, 0, 0xffff_ffff))
  ) {
    throw new Error('preview candidate sample is malformed');
  }
  if (record.stage === 'sample-complete' && record.sample === undefined) {
    throw new Error('only a map-test candidate can complete a sample');
  }
  let bytes = 0;
  let objects = 0;
  let cliffs = 0;
  let previousKey = -1;
  const chunks: PreviewCandidateChunk[] = [];
  for (const chunk of record.chunks as Partial<PreviewCandidateChunk>[]) {
    if (
      !chunk ||
      typeof chunk !== 'object' ||
      !isBoundedInteger(chunk.chunkX, 0, columns - 1) ||
      !isBoundedInteger(chunk.chunkY, 0, rows - 1) ||
      !(chunk.terrainIdsLe instanceof Uint8Array) ||
      !(chunk.elevations instanceof Uint8Array) ||
      !(chunk.cliffEdges instanceof Uint8Array) ||
      !(chunk.objects instanceof Uint8Array)
    ) {
      throw new Error('preview candidate chunk is malformed');
    }
    const key = chunk.chunkY * columns + chunk.chunkX;
    if (key <= previousKey) throw new Error('preview candidate chunks are not unique and ordered');
    previousKey = key;
    const tiles = previewCandidateChunkTileCount(
      record.width,
      record.height,
      chunk.chunkX,
      chunk.chunkY,
    );
    if (
      chunk.terrainIdsLe.byteLength !== tiles * 2 ||
      chunk.elevations.byteLength !== tiles ||
      chunk.cliffEdges.byteLength % previewCandidateCliffRecordBytes !== 0 ||
      chunk.objects.byteLength % previewCandidateObjectRecordBytes !== 0
    ) {
      throw new Error('preview candidate chunk columns have invalid lengths');
    }
    bytes +=
      chunk.terrainIdsLe.byteLength +
      chunk.elevations.byteLength +
      chunk.cliffEdges.byteLength +
      chunk.objects.byteLength;
    objects += chunk.objects.byteLength / previewCandidateObjectRecordBytes;
    cliffs += chunk.cliffEdges.byteLength / previewCandidateCliffRecordBytes;
    if (
      bytes > maximumPreviewCandidateBytes ||
      objects > maximumPreviewCandidateObjects ||
      cliffs > maximumPreviewCandidateCliffs
    ) {
      throw new Error('preview candidate exceeds its bounds');
    }
    validateChunkRecords(chunk as PreviewCandidateChunk, record.width, record.height);
    chunks.push(
      Object.freeze({
        chunkX: chunk.chunkX,
        chunkY: chunk.chunkY,
        terrainIdsLe: chunk.terrainIdsLe,
        elevations: chunk.elevations,
        cliffEdges: chunk.cliffEdges,
        objects: chunk.objects,
      }),
    );
  }
  return Object.freeze({
    requestId: record.requestId,
    revision: record.revision,
    baseRevision: record.baseRevision,
    stage: record.stage as PreviewCandidateStage,
    width: record.width,
    height: record.height,
    elapsedUs: record.elapsedUs,
    ...(record.sample
      ? { sample: Object.freeze({ ordinal: record.sample.ordinal, seed: record.sample.seed }) }
      : {}),
    chunks: Object.freeze(chunks) as PreviewCandidateChunk[],
  });
}

function validateChunkRecords(chunk: PreviewCandidateChunk, width: number, height: number): void {
  const bounds = previewCandidateChunkBounds(width, height, chunk.chunkX, chunk.chunkY);
  const cliffs = new DataView(
    chunk.cliffEdges.buffer,
    chunk.cliffEdges.byteOffset,
    chunk.cliffEdges.byteLength,
  );
  for (let offset = 0; offset < chunk.cliffEdges.byteLength; offset += 12) {
    const fromX = cliffs.getUint16(offset, true);
    const fromY = cliffs.getUint16(offset + 2, true);
    const toX = cliffs.getUint16(offset + 4, true);
    const toY = cliffs.getUint16(offset + 6, true);
    if (
      fromX >= width ||
      toX >= width ||
      fromY >= height ||
      toY >= height ||
      fromX < bounds.minimumX ||
      fromX > bounds.maximumX ||
      fromY < bounds.minimumY ||
      fromY > bounds.maximumY
    ) {
      throw new Error('preview candidate cliff lies outside its chunk');
    }
  }
  const objects = new DataView(
    chunk.objects.buffer,
    chunk.objects.byteOffset,
    chunk.objects.byteLength,
  );
  for (let offset = 0; offset < chunk.objects.byteLength; offset += 18) {
    const tileX = Math.floor(objects.getUint32(offset + 4, true) / 256);
    const tileY = Math.floor(objects.getUint32(offset + 8, true) / 256);
    if (
      Math.min(tileX, width - 1) < bounds.minimumX ||
      Math.min(tileX, width - 1) > bounds.maximumX ||
      Math.min(tileY, height - 1) < bounds.minimumY ||
      Math.min(tileY, height - 1) > bounds.maximumY ||
      chunk.objects[offset + 17]! > 1
    ) {
      throw new Error('preview candidate object lies outside its chunk');
    }
  }
}

export function composePreviewCandidates(
  pending: PreviewCandidate,
  next: PreviewCandidate,
): PreviewCandidate | null {
  if (next.requestId !== pending.requestId || next.revision <= pending.revision) return null;
  if (next.baseRevision === 0) return next;
  if (
    next.baseRevision !== pending.revision ||
    next.width !== pending.width ||
    next.height !== pending.height
  ) {
    return null;
  }
  const { columns } = previewCandidateChunkGrid(next.width, next.height);
  const chunks = new Map<number, PreviewCandidateChunk>();
  for (const chunk of pending.chunks) chunks.set(chunk.chunkY * columns + chunk.chunkX, chunk);
  for (const chunk of next.chunks) chunks.set(chunk.chunkY * columns + chunk.chunkX, chunk);
  return {
    ...next,
    baseRevision: pending.baseRevision,
    chunks: [...chunks.entries()].sort(([left], [right]) => left - right).map(([, chunk]) => chunk),
  };
}

export function validatePreviewCandidateAcknowledgement(
  value: unknown,
): PreviewCandidateAcknowledgement {
  const record = value as Partial<PreviewCandidateAcknowledgement> | null | undefined;
  if (
    !record ||
    typeof record !== 'object' ||
    typeof record.requestId !== 'string' ||
    record.requestId.length < 1 ||
    record.requestId.length > 512 ||
    !isBoundedInteger(record.revision, 1, maximumPreviewCandidateRevision) ||
    typeof record.accepted !== 'boolean'
  ) {
    throw new Error('preview candidate acknowledgement is malformed');
  }
  return { requestId: record.requestId, revision: record.revision, accepted: record.accepted };
}
