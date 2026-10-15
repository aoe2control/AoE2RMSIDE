import type { Stats } from 'node:fs';
import { extname } from 'node:path';
import { maximumWorkspaceTreeChangePaths } from '../shared/workspace-tree-change';

export interface TreeChangeBatch {
  all: boolean;
  changes: { path: string; structural: boolean }[];
}

export interface TreeChangeTimers {
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const systemTimers: TreeChangeTimers = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => performance.now(),
};

export class TreeChangeCoalescer {
  private readonly pending = new Map<string, { path: string; structural: boolean }>();
  private all = false;
  private firstEventAt: number | null = null;
  private timer: unknown = null;
  private disposed = false;

  constructor(
    private readonly flush: (batch: TreeChangeBatch) => void,
    private readonly key: (path: string) => string,
    private readonly options: { quietMs: number; maximumWaitMs: number; maximumPaths: number } = {
      quietMs: 100,
      maximumWaitMs: 1_000,
      maximumPaths: maximumWorkspaceTreeChangePaths,
    },
    private readonly timers: TreeChangeTimers = systemTimers,
  ) {}

  add(path: string | null, eventType: string): void {
    if (this.disposed) return;
    if (path === null) this.all = true;
    else if (!this.all) {
      const key = this.key(path);
      const existing = this.pending.get(key);
      const structural = eventType !== 'change';
      if (existing) existing.structural ||= structural;
      else if (this.pending.size >= this.options.maximumPaths) this.all = true;
      else this.pending.set(key, { path, structural });
    }
    if (this.all) this.pending.clear();
    this.schedule();
  }

  addAll(): void {
    this.add(null, 'rename');
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private schedule(): void {
    const now = this.timers.now();
    this.firstEventAt ??= now;
    if (this.timer !== null) this.timers.clear(this.timer);
    const delay = Math.max(
      0,
      Math.min(this.options.quietMs, this.firstEventAt + this.options.maximumWaitMs - now),
    );
    this.timer = this.timers.set(() => this.emit(), delay);
  }

  private emit(): void {
    this.timer = null;
    this.firstEventAt = null;
    const batch: TreeChangeBatch = { all: this.all, changes: [...this.pending.values()] };
    this.all = false;
    this.pending.clear();
    if (this.disposed) return;
    this.flush(batch);
  }
}

export async function explorerListingChanges(
  changes: readonly { path: string; structural: boolean }[],
  isSourceExtension: (extension: string) => boolean,
  statPath: (path: string) => Promise<Stats>,
): Promise<string[]> {
  const listed: string[] = [];
  for (const change of changes) {
    let metadata: Stats;
    try {
      metadata = await statPath(change.path);
    } catch {
      listed.push(change.path);
      continue;
    }
    if (!change.structural) continue;
    if (metadata.isDirectory()) listed.push(change.path);
    else if (isSourceExtension(extname(change.path).toLocaleLowerCase('en-US'))) {
      listed.push(change.path);
    }
  }
  return listed;
}
