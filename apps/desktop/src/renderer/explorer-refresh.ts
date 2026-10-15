import type { WorkspaceDirectoryEntry } from '../shared/api';
import type { WorkspaceTreeChange } from '../shared/workspace-tree-change';
import { explorerParentPath, explorerPathKey } from './explorer-search-tree';

export function explorerRefreshKeys(
  rootPath: string,
  change: WorkspaceTreeChange,
  loadedKeys: ReadonlySet<string>,
): string[] {
  const rootKey = explorerPathKey(rootPath);
  if (explorerPathKey(change.root) !== rootKey) return [];
  if (change.kind === 'all') return [...loadedKeys].sort(compareDepth);
  const affected = new Set<string>();
  const inside = `${rootKey}/`;
  for (const path of change.paths) {
    let current = path;
    let key = explorerPathKey(current);
    if (key !== rootKey && !key.startsWith(inside)) continue;
    while (!affected.has(key)) {
      if (loadedKeys.has(key)) affected.add(key);
      if (key === rootKey || current.length === 0) break;
      current = explorerParentPath(current);
      key = explorerPathKey(current);
    }
  }
  return [...affected].sort(compareDepth);
}

function compareDepth(left: string, right: string): number {
  return left.split('/').length - right.split('/').length || (left < right ? -1 : 1);
}

export function mergeDirectoryEntries(
  previous: readonly WorkspaceDirectoryEntry[],
  next: readonly WorkspaceDirectoryEntry[],
): WorkspaceDirectoryEntry[] {
  const known = new Map(previous.map((entry) => [entry.id, entry]));
  let changed = previous.length !== next.length;
  const merged = next.map((entry, index) => {
    const existing = known.get(entry.id);
    const kept = existing && sameEntry(existing, entry) ? existing : entry;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? merged : (previous as WorkspaceDirectoryEntry[]);
}

function sameEntry(left: WorkspaceDirectoryEntry, right: WorkspaceDirectoryEntry): boolean {
  return (
    left.path === right.path &&
    left.name === right.name &&
    left.kind === right.kind &&
    left.writable === right.writable &&
    left.hasChildren === right.hasChildren
  );
}

export class ExplorerRefreshRegistry {
  private readonly listings = new Map<string, Set<() => void>>();

  register(path: string, refresh: () => void): () => void {
    const key = explorerPathKey(path);
    let refreshers = this.listings.get(key);
    if (!refreshers) {
      refreshers = new Set();
      this.listings.set(key, refreshers);
    }
    refreshers.add(refresh);
    return () => {
      refreshers.delete(refresh);
      if (refreshers.size === 0 && this.listings.get(key) === refreshers) {
        this.listings.delete(key);
      }
    };
  }

  refresh(rootPath: string, change: WorkspaceTreeChange): number {
    const keys = explorerRefreshKeys(rootPath, change, new Set(this.listings.keys()));
    for (const key of keys) {
      for (const refresh of this.listings.get(key) ?? []) refresh();
    }
    return keys.length;
  }
}

export class DirectoryListingReader {
  private request = 0;
  private inFlight = false;
  private again = false;

  constructor(
    private readonly read: () => Promise<WorkspaceDirectoryEntry[]>,
    private readonly settle: (
      result: { entries: WorkspaceDirectoryEntry[] } | { error: unknown },
      refresh: boolean,
    ) => void,
  ) {}

  restart(refresh: boolean): void {
    this.again = false;
    this.run(refresh);
  }

  refresh(): void {
    if (this.inFlight) this.again = true;
    else this.run(true);
  }

  dispose(): void {
    this.request += 1;
    this.inFlight = false;
    this.again = false;
  }

  private run(refresh: boolean): void {
    const request = ++this.request;
    this.inFlight = true;
    const finish = (result: { entries: WorkspaceDirectoryEntry[] } | { error: unknown }) => {
      if (request !== this.request) return;
      this.inFlight = false;
      this.settle(result, refresh);
      if (this.again) {
        this.again = false;
        this.run(true);
      }
    };
    void this.read().then(
      (entries) => finish({ entries }),
      (error: unknown) => finish({ error }),
    );
  }
}
