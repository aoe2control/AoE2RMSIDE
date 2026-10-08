export interface PreviewCacheDiagnostics {
  entries: number;
  bytes: number;
  hits: number;
  misses: number;
  evictions: number;
}

export interface PreviewCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  clear(): void;
  diagnostics(): PreviewCacheDiagnostics;
}

export class BoundedPreviewLru<T> implements PreviewCache<T> {
  private readonly values = new Map<string, { bytes: number; value: T }>();
  private byteSize = 0;
  private hitCount = 0;
  private missCount = 0;
  private evictionCount = 0;

  constructor(
    private readonly maximumEntries: number,
    private readonly maximumBytes: number,
    private readonly sizeOf: (value: T) => number,
  ) {
    if (!Number.isSafeInteger(maximumEntries) || maximumEntries < 1) {
      throw new Error('preview cache entry bound must be positive');
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new Error('preview cache byte bound must be positive');
    }
  }

  get(key: string): T | undefined {
    const entry = this.values.get(key);
    if (!entry) {
      this.missCount += 1;
      return undefined;
    }
    this.hitCount += 1;
    this.values.delete(key);
    this.values.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    const bytes = Math.max(0, Math.trunc(this.sizeOf(value)));
    const previous = this.values.get(key);
    if (previous) {
      this.byteSize -= previous.bytes;
      this.values.delete(key);
    }
    if (bytes > this.maximumBytes) return;
    this.values.set(key, { bytes, value });
    this.byteSize += bytes;
    while (this.values.size > this.maximumEntries || this.byteSize > this.maximumBytes) {
      const oldestKey = this.values.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.values.get(oldestKey)!;
      this.values.delete(oldestKey);
      this.byteSize -= oldest.bytes;
      this.evictionCount += 1;
    }
  }

  clear(): void {
    this.values.clear();
    this.byteSize = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.evictionCount = 0;
  }

  diagnostics(): PreviewCacheDiagnostics {
    return {
      entries: this.values.size,
      bytes: this.byteSize,
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
    };
  }
}
