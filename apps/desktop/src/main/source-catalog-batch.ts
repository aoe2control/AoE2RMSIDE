import { desktopErrorMessage } from '../shared/desktop-error';

const limits = {
  roots: 64,
  records: 4096,
  bytes: 16 * 1024 * 1024,
  metadata: 2 * 1024 * 1024,
} as const;
type BatchLimit = keyof typeof limits;

export class SourceCatalogBatchError extends Error {
  constructor(
    readonly limit: BatchLimit,
    readonly used: number,
    readonly maximum: number,
  ) {
    super(
      desktopErrorMessage(
        `source-catalog.batch.${limit}`,
        `Map-test source batch exceeds its ${limit} limit (${used}/${maximum}). Run fewer maps in one test.`,
        { used, maximum },
      ),
    );
    this.name = 'SourceCatalogBatchError';
  }
}

export function assertMapTestRootCount(count: number): void {
  if (count > limits.roots) throw new SourceCatalogBatchError('roots', count, limits.roots);
}

export function addPinnedMapTestSource(paths: Set<string>, pin: string | undefined): void {
  if (pin) paths.add(pin);
  assertMapTestRootCount(paths.size);
}

export class SourceCatalogBatchBudget {
  private readonly used = { roots: 0, records: 0, bytes: 0, metadata: 0 };

  charge(limit: BatchLimit, amount: number): void {
    this.check(limit, amount);
    this.used[limit] += amount;
  }

  checkBytes(bytes: number): void {
    this.check('bytes', bytes);
  }
  checkRootRead(bytes: number): void {
    this.check('roots', 1);
    this.check('records', 1);
    this.check('bytes', bytes);
  }
  remainingSourceBytes(): number {
    return limits.bytes - this.used.bytes;
  }
  catalogRevision(): number {
    return this.used.roots;
  }

  private check(limit: BatchLimit, amount: number): void {
    const total = this.used[limit] + amount;
    if (!Number.isSafeInteger(total) || amount < 0 || total > limits[limit]) {
      throw new SourceCatalogBatchError(limit, total, limits[limit]);
    }
  }
}
