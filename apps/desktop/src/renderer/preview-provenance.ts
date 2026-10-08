import type { PreviewGenerationResult, PreviewProvenanceOperation } from '../shared/api';
import type { LivePreviewAnalysis, LivePreviewDocument } from './live-preview';
import { sameSourceIdentity } from './source-identity';

interface ByteEdit {
  oldStart: number;
  oldEnd: number;
  newEnd: number;
  newLength: number;
}

export function remapEquivalentPreviewResult(
  result: PreviewGenerationResult,
  analysis: LivePreviewAnalysis,
  document: LivePreviewDocument,
  previousContent = '',
): PreviewGenerationResult {
  const currentOperations = new Map(
    analysis.operations.map((operation) => [operation.operationIdentity, operation]),
  );
  let complete = true;
  const fallback = remapHistoricalProvenance(result, previousContent, document);
  const provenanceOperations = result.provenanceOperations.map((operation, index) => {
    const current = currentOperations.get(operation.operationIdentity);
    if (current) return current;
    complete = false;
    return fallback.provenanceOperations[index] ?? operation;
  });
  const direct = remapDirectTileProvenance(fallback, provenanceOperations);
  return {
    ...direct,
    documentUri: document.uri,
    documentRevision: document.revision,
    semanticProgramHash: analysis.semanticHash,
    provenanceOperations,
    provenanceStatus: complete ? 'remapped' : 'approximate',
  };
}

export function remapHistoricalPreviewResult(
  result: PreviewGenerationResult,
  previousContent: string,
  document: LivePreviewDocument,
): PreviewGenerationResult {
  return {
    ...remapHistoricalProvenance(result, previousContent, document),
    documentUri: document.uri,
    documentRevision: document.revision,
    provenanceStatus: 'approximate',
  };
}

export function trackUtf8ByteRange(
  previousContent: string,
  nextContent: string,
  byteStart: number,
  byteEnd: number,
): { byteStart: number; byteEnd: number } {
  return trackUtf8ByteRangeThroughEdit(
    changedByteInterval(previousContent, nextContent),
    byteStart,
    byteEnd,
  );
}

function trackUtf8ByteRangeThroughEdit(
  edit: ByteEdit,
  byteStart: number,
  byteEnd: number,
): { byteStart: number; byteEnd: number } {
  const start = clampInteger(byteStart, 0, edit.oldEnd + (edit.newLength - edit.newEnd));
  const end = clampInteger(byteEnd, start, edit.oldEnd + (edit.newLength - edit.newEnd));
  const delta = edit.newEnd - edit.oldEnd;
  if (end <= edit.oldStart) return { byteStart: start, byteEnd: end };
  if (start >= edit.oldEnd) {
    return {
      byteStart: clampInteger(start + delta, 0, edit.newLength),
      byteEnd: clampInteger(end + delta, 0, edit.newLength),
    };
  }
  return {
    byteStart: Math.min(start, edit.oldStart),
    byteEnd: clampInteger(end > edit.oldEnd ? end + delta : edit.newEnd, 0, edit.newLength),
  };
}

function remapHistoricalProvenance(
  result: PreviewGenerationResult,
  previousContent: string,
  document: LivePreviewDocument,
): PreviewGenerationResult {
  const oldDocumentUri = result.documentUri;
  const oldDocumentSourceIndices = new Set(
    result.sourceIds.flatMap((sourceId, index) =>
      sameSourceIdentity(sourceId, oldDocumentUri) ? [index] : [],
    ),
  );
  const sourceIds = result.sourceIds.map((sourceId) =>
    sameSourceIdentity(sourceId, oldDocumentUri) ? document.uri : sourceId,
  );
  const edit = changedByteInterval(previousContent, document.content);
  const provenanceOperations = result.provenanceOperations.map((operation) => ({
    ...(sameSourceIdentity(operation.sourceId, oldDocumentUri)
      ? remapHistoricalOperation(operation, edit, document)
      : operation),
    includeChain: operation.includeChain.map((sourceId) =>
      sameSourceIdentity(sourceId, oldDocumentUri) ? document.uri : sourceId,
    ),
  }));
  const tileByteStartsLe = Uint8Array.from(result.tileByteStartsLe);
  const tileByteEndsLe = Uint8Array.from(result.tileByteEndsLe);
  if (oldDocumentSourceIndices.size > 0) {
    const sourceIndices = new DataView(
      result.tileSourceIndicesLe.buffer,
      result.tileSourceIndicesLe.byteOffset,
      result.tileSourceIndicesLe.byteLength,
    );
    const starts = new DataView(
      tileByteStartsLe.buffer,
      tileByteStartsLe.byteOffset,
      tileByteStartsLe.byteLength,
    );
    const ends = new DataView(
      tileByteEndsLe.buffer,
      tileByteEndsLe.byteOffset,
      tileByteEndsLe.byteLength,
    );
    for (let offset = 0; offset < result.tileSourceIndicesLe.byteLength; offset += 2) {
      if (!oldDocumentSourceIndices.has(sourceIndices.getUint16(offset, true))) continue;
      const rangeOffset = offset * 2;
      const range = trackUtf8ByteRangeThroughEdit(
        edit,
        starts.getUint32(rangeOffset, true),
        ends.getUint32(rangeOffset, true),
      );
      starts.setUint32(rangeOffset, range.byteStart, true);
      ends.setUint32(rangeOffset, range.byteEnd, true);
    }
  }
  return {
    ...result,
    sourceIds,
    tileByteStartsLe,
    tileByteEndsLe,
    provenanceOperations,
  };
}

function remapHistoricalOperation(
  operation: PreviewProvenanceOperation,
  edit: ByteEdit,
  document: LivePreviewDocument,
): PreviewProvenanceOperation {
  const range = trackUtf8ByteRangeThroughEdit(edit, operation.byteStart, operation.byteEnd);
  return {
    ...operation,
    ...range,
    sourceId: document.uri,
  };
}

function remapDirectTileProvenance(
  result: PreviewGenerationResult,
  operations: PreviewProvenanceOperation[],
): PreviewGenerationResult {
  const sourceIds = [...result.sourceIds];
  const tileSourceIndicesLe = Uint8Array.from(result.tileSourceIndicesLe);
  const tileByteStartsLe = Uint8Array.from(result.tileByteStartsLe);
  const tileByteEndsLe = Uint8Array.from(result.tileByteEndsLe);
  const operationIndices = new DataView(
    result.tileOperationIndicesLe.buffer,
    result.tileOperationIndicesLe.byteOffset,
    result.tileOperationIndicesLe.byteLength,
  );
  const sourceIndices = new DataView(
    tileSourceIndicesLe.buffer,
    tileSourceIndicesLe.byteOffset,
    tileSourceIndicesLe.byteLength,
  );
  const starts = new DataView(
    tileByteStartsLe.buffer,
    tileByteStartsLe.byteOffset,
    tileByteStartsLe.byteLength,
  );
  const ends = new DataView(
    tileByteEndsLe.buffer,
    tileByteEndsLe.byteOffset,
    tileByteEndsLe.byteLength,
  );
  for (
    let operationOffset = 0;
    operationOffset < result.tileOperationIndicesLe.byteLength;
    operationOffset += 4
  ) {
    const operationIndex = operationIndices.getUint32(operationOffset, true);
    const operation = operations[operationIndex];
    if (!operation) continue;
    let sourceIndex = sourceIds.indexOf(operation.sourceId);
    if (sourceIndex < 0) {
      if (sourceIds.length >= 0xffff) continue;
      sourceIndex = sourceIds.length;
      sourceIds.push(operation.sourceId);
    }
    const tileOffset = operationOffset / 2;
    sourceIndices.setUint16(tileOffset, sourceIndex, true);
    starts.setUint32(operationOffset, operation.byteStart, true);
    ends.setUint32(operationOffset, operation.byteEnd, true);
  }
  return { ...result, sourceIds, tileSourceIndicesLe, tileByteStartsLe, tileByteEndsLe };
}

function changedByteInterval(previousContent: string, nextContent: string): ByteEdit {
  let prefix = 0;
  const maximumPrefix = Math.min(previousContent.length, nextContent.length);
  while (prefix < maximumPrefix && previousContent[prefix] === nextContent[prefix]) prefix += 1;
  if (prefix > 0 && isHighSurrogate(previousContent.charCodeAt(prefix - 1))) prefix -= 1;
  let oldSuffix = previousContent.length;
  let newSuffix = nextContent.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    previousContent[oldSuffix - 1] === nextContent[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }
  if (oldSuffix < previousContent.length && isLowSurrogate(previousContent.charCodeAt(oldSuffix))) {
    oldSuffix += 1;
    newSuffix += 1;
  }
  const encoder = new TextEncoder();
  const oldStart = encoder.encode(previousContent.slice(0, prefix)).byteLength;
  return {
    oldStart,
    oldEnd: oldStart + encoder.encode(previousContent.slice(prefix, oldSuffix)).byteLength,
    newEnd: oldStart + encoder.encode(nextContent.slice(prefix, newSuffix)).byteLength,
    newLength: encoder.encode(nextContent).byteLength,
  };
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}
