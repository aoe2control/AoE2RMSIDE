import type { MapIconSourceRequest } from './api';

export const mapIconSourceSeedMaximum = 0xffff_ffff;

export const mapIconSourceRequestIdLimit = 128;

const requestKeys = [
  'boundSemanticHash',
  'clientRequestId',
  'documentRevision',
  'documentUri',
  'externalAssetHash',
  'seed',
  'sourceCatalogHash',
  'sourceCatalogRevision',
  'sourceGraphHash',
].join(',');

const lowercaseSha256Pattern = /^[0-9a-f]{64}$/u;
const requestIdPattern = /^[A-Za-z0-9._:-]+$/u;

export function validMapIconSourceSeed(seed: unknown): seed is number {
  return (
    typeof seed === 'number' &&
    Number.isSafeInteger(seed) &&
    seed >= 0 &&
    seed <= mapIconSourceSeedMaximum
  );
}

export function validMapIconSourceRequestId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= mapIconSourceRequestIdLimit &&
    requestIdPattern.test(value)
  );
}

export function validateMapIconSourceRequest(value: unknown): MapIconSourceRequest {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== requestKeys
  ) {
    throw new Error('map icon generation request is invalid');
  }
  const request = value as Record<string, unknown>;
  if (!validMapIconSourceRequestId(request.clientRequestId)) {
    throw new Error('map icon generation request identity is invalid');
  }
  if (!validMapIconSourceSeed(request.seed)) {
    throw new Error('map icon seed is outside the unsigned 32-bit range');
  }
  if (
    typeof request.documentUri !== 'string' ||
    request.documentUri.length < 1 ||
    request.documentUri.length > 4096 ||
    !Number.isSafeInteger(request.documentRevision) ||
    (request.documentRevision as number) < 0 ||
    !Number.isSafeInteger(request.sourceCatalogRevision) ||
    (request.sourceCatalogRevision as number) < 0 ||
    [
      request.sourceCatalogHash,
      request.sourceGraphHash,
      request.externalAssetHash,
      request.boundSemanticHash,
    ].some((hash) => typeof hash !== 'string' || !lowercaseSha256Pattern.test(hash))
  ) {
    throw new Error('map icon generation identity is invalid');
  }
  return Object.freeze({
    clientRequestId: request.clientRequestId,
    documentUri: request.documentUri,
    documentRevision: request.documentRevision as number,
    sourceCatalogRevision: request.sourceCatalogRevision as number,
    sourceCatalogHash: request.sourceCatalogHash as string,
    sourceGraphHash: request.sourceGraphHash as string,
    externalAssetHash: request.externalAssetHash as string,
    boundSemanticHash: request.boundSemanticHash as string,
    seed: request.seed,
  });
}
