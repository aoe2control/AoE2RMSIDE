import type { WorkspaceDirectoryEntry, WorkspaceSearchResult } from '../shared/api';
import { workspaceSearchMatch, type WorkspaceSearchNameRange } from '../shared/workspace-search';

export interface ExplorerSearchTree {
  query: string;
  children: ReadonlyMap<string, readonly WorkspaceDirectoryEntry[]>;
  shown: ReadonlySet<string>;
  matches: ReadonlyMap<string, WorkspaceSearchNameRange>;
  counts: ReadonlyMap<string, number>;
}

export function explorerPathKey(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/u, '').toLocaleLowerCase('en-US');
}

export function explorerParentPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return path.slice(0, normalized.lastIndexOf('/'));
}

export function buildExplorerSearchTree(
  rootPath: string,
  query: string,
  results: readonly WorkspaceSearchResult[],
): ExplorerSearchTree {
  const rootKey = explorerPathKey(rootPath);
  const children = new Map<string, WorkspaceDirectoryEntry[]>();
  const shown = new Set<string>();
  const matches = new Map<string, WorkspaceSearchNameRange>();
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = explorerPathKey(result.path);
    const parentKey = explorerPathKey(explorerParentPath(result.path));
    if (shown.has(key) || (parentKey !== rootKey && !shown.has(parentKey))) continue;
    const { relativePath, matched, occurrences, ...entry } = result;
    shown.add(key);
    const siblings = children.get(parentKey);
    if (siblings) siblings.push(entry);
    else children.set(parentKey, [entry]);
    if (matched && occurrences !== undefined) {
      matches.set(key, { start: 0, end: 0 });
      const count = Math.max(0, Math.trunc(occurrences));
      counts.set(key, count);
      for (
        let folderKey = parentKey;
        folderKey === rootKey || shown.has(folderKey);
        folderKey = explorerPathKey(explorerParentPath(folderKey))
      ) {
        counts.set(folderKey, (counts.get(folderKey) ?? 0) + count);
        if (folderKey === rootKey) break;
      }
    } else if (matched) {
      matches.set(key, workspaceSearchMatch(query, relativePath) ?? { start: 0, end: 0 });
    }
  }
  return { children, counts, matches, query, shown };
}

export function explorerFolderExpanded(
  key: string,
  userExpanded: boolean,
  tree: ExplorerSearchTree | null,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  if (!tree || !tree.shown.has(key)) return userExpanded;
  return overrides.get(key) ?? tree.children.has(key);
}

export function explorerSearchInside(
  key: string,
  tree: ExplorerSearchTree | null,
): ExplorerSearchTree | null {
  if (!tree || !tree.shown.has(key)) return tree;
  return tree.children.has(key) ? tree : null;
}

export function visibleExplorerMatches(
  rootPath: string,
  tree: ExplorerSearchTree,
  overrides: ReadonlyMap<string, boolean>,
): WorkspaceDirectoryEntry[] {
  const visible: WorkspaceDirectoryEntry[] = [];
  const visit = (parentKey: string) => {
    for (const entry of tree.children.get(parentKey) ?? []) {
      const key = explorerPathKey(entry.path);
      if (tree.matches.has(key)) visible.push(entry);
      if (
        entry.kind === 'folder' &&
        tree.children.has(key) &&
        explorerFolderExpanded(key, false, tree, overrides)
      ) {
        visit(key);
      }
    }
  };
  visit(explorerPathKey(rootPath));
  return visible;
}

export function explorerActiveMatch(
  visible: readonly WorkspaceDirectoryEntry[],
  keyboardKey: string | null,
  selectedKey: string,
): WorkspaceDirectoryEntry | undefined {
  const find = (key: string | null) =>
    key ? visible.find((entry) => explorerPathKey(entry.path) === key) : undefined;
  return find(keyboardKey) ?? find(selectedKey) ?? visible[0];
}

export function explorerAncestorFolders(rootPath: string, path: string): string[] {
  const inside = `${explorerPathKey(rootPath)}/`;
  if (!explorerPathKey(path).startsWith(inside)) return [];
  const ancestors: string[] = [];
  for (
    let current = explorerParentPath(path);
    explorerPathKey(current).startsWith(inside);
    current = explorerParentPath(current)
  ) {
    ancestors.unshift(current);
  }
  return ancestors;
}

export interface ExplorerRevealView<Row> {
  findRow(key: string): Row | null;
  loading(): boolean;
  reveal(row: Row): void;
}

export class ExplorerPendingReveal<Row> {
  private key: string | null = null;

  constructor(private readonly view: ExplorerRevealView<Row>) {}

  get pending(): string | null {
    return this.key;
  }

  request(key: string): void {
    this.key = key;
    this.treeChanged();
  }

  cancel(): void {
    this.key = null;
  }

  treeChanged(): void {
    const key = this.key;
    if (key === null) return;
    const row = this.view.findRow(key);
    if (row !== null) this.view.reveal(row);
    if (!this.view.loading()) this.key = null;
  }
}

export function compareExplorerEntries(
  left: WorkspaceDirectoryEntry,
  right: WorkspaceDirectoryEntry,
): number {
  if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
  const leftName = left.name.toLocaleLowerCase('en-US');
  const rightName = right.name.toLocaleLowerCase('en-US');
  if (leftName !== rightName) return leftName < rightName ? -1 : 1;
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

export function explorerSearchRows(
  loaded: readonly WorkspaceDirectoryEntry[] | null,
  shown: readonly WorkspaceDirectoryEntry[],
): WorkspaceDirectoryEntry[] {
  if (!loaded) return [...shown];
  const known = new Set(loaded.map((entry) => explorerPathKey(entry.path)));
  const extra = shown.filter((entry) => !known.has(explorerPathKey(entry.path)));
  return extra.length === 0 ? [...loaded] : [...loaded, ...extra].sort(compareExplorerEntries);
}
