import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { FileTooLargeError, readFileBounded } from './bounded-file';
import { RequiredSourceLimitError } from './source-catalog-limits';
import { SourceCatalogDiscoveryError, type SourceCatalogProbes } from './source-catalog-probes';

export const sourceMaximumFileBytes = 4 * 1024 * 1024;
export const sourceMaximumAggregateBytes = 16 * 1024 * 1024;

export interface SourceByteBudget {
  remainingBytes: number;
  beforeCharge?: (bytes: number) => void;
  readCeiling?: () => number;
}

export class SourceByteLimitError extends RequiredSourceLimitError {
  constructor(
    readonly limit: 'file' | 'aggregate',
    used: number,
    maximum: number,
    scope = 'source graph',
  ) {
    super(limit === 'file' ? 'file' : 'bytes', scope, used, maximum);
    this.name = 'SourceByteLimitError';
  }
}
export interface SourceSnapshot {
  bytes: Uint8Array;
  rawHash: Uint8Array;
  modifiedMilliseconds: number;
  changedMilliseconds: number;
  fileIdentity: string;
  size: number;
}

export function chargeSourceBytes(budget: SourceByteBudget, bytes: number, scope?: string): void {
  if (budget.remainingBytes < bytes) {
    throw new SourceByteLimitError(
      'aggregate',
      sourceMaximumAggregateBytes - budget.remainingBytes + bytes,
      sourceMaximumAggregateBytes,
      scope,
    );
  }
  budget.beforeCharge?.(bytes);
  budget.remainingBytes -= bytes;
}

export class SourceSnapshotCache {
  private readonly snapshots = new Map<string, SourceSnapshot>();
  private retainedBytes = 0;

  invalidate(path: string | null = null): void {
    if (path) this.forget(key(path));
    else {
      this.snapshots.clear();
      this.retainedBytes = 0;
    }
  }

  async read(
    path: string,
    budget: SourceByteBudget,
    probes: SourceCatalogProbes,
  ): Promise<SourceSnapshot> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('source catalog file is not a bounded regular file');
    }
    if (metadata.size > sourceMaximumFileBytes)
      throw new SourceByteLimitError('file', metadata.size, sourceMaximumFileBytes, path);
    const batchCeiling = budget.readCeiling?.() ?? sourceMaximumFileBytes;
    const graphCeiling = budget.remainingBytes;
    const readCeiling = Math.min(sourceMaximumFileBytes, graphCeiling, batchCeiling);
    chargeSourceBytes(budget, metadata.size, path);
    const pathKey = key(path);
    const current = this.snapshots.get(pathKey);
    const bytes = await readFileBounded(path, readCeiling, (opened) =>
      probes.authorizeRead(path, opened),
    ).catch((error: unknown) => {
      if (!(error instanceof FileTooLargeError)) throw error;
      if (readCeiling === sourceMaximumFileBytes)
        throw new SourceByteLimitError('file', error.observedBytes, sourceMaximumFileBytes, path);
      if (batchCeiling < graphCeiling) {
        budget.beforeCharge?.(Math.max(0, error.observedBytes - metadata.size));
        throw error;
      }
      chargeSourceBytes(budget, Math.max(0, error.observedBytes - metadata.size), path);
      throw error;
    });
    chargeSourceBytes(budget, Math.max(0, bytes.byteLength - metadata.size), path);
    const after = await lstat(path);
    if (
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.size !== metadata.size ||
      after.mtimeMs !== metadata.mtimeMs ||
      after.ctimeMs !== metadata.ctimeMs
    ) {
      throw new SourceCatalogDiscoveryError('stale', path, 1, 0);
    }
    const rawHash = createHash('sha256').update(bytes).digest();
    probes.recordContent(path, rawHash, bytes.byteLength);
    const unchanged = current && Buffer.from(current.rawHash).equals(rawHash);
    const snapshot: SourceSnapshot = {
      bytes: unchanged ? current.bytes : bytes,
      rawHash: unchanged ? current.rawHash : rawHash,
      modifiedMilliseconds: metadata.mtimeMs,
      changedMilliseconds: metadata.ctimeMs,
      fileIdentity: `${metadata.dev}:${metadata.ino}`,
      size: bytes.byteLength,
    };
    this.forget(pathKey);
    this.snapshots.set(pathKey, snapshot);
    this.retainedBytes += snapshot.size;
    while (this.retainedBytes > sourceMaximumAggregateBytes * 2 && this.snapshots.size > 1) {
      this.forget(this.snapshots.keys().next().value!);
    }
    return snapshot;
  }

  private forget(path: string): void {
    const snapshot = this.snapshots.get(path);
    if (!snapshot) return;
    this.snapshots.delete(path);
    this.retainedBytes -= snapshot.size;
  }
}

function key(path: string): string {
  return resolve(path).toLocaleLowerCase('en-US');
}
