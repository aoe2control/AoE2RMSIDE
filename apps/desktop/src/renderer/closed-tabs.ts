import type { MonacoViewState, WorkspaceSourceKind } from '../shared/api';

export interface ClosedTab {
  path: string;
  uri: string;
  sourceKind: WorkspaceSourceKind;
  index: number;
  viewState: MonacoViewState | null;
}

export const maximumClosedTabs = 32;

export function rememberClosedTab(history: readonly ClosedTab[], tab: ClosedTab): ClosedTab[] {
  const key = closedTabKey(tab.path);
  const next = history.filter((entry) => closedTabKey(entry.path) !== key);
  next.push(tab);
  return next.slice(-maximumClosedTabs);
}

export function takeClosedTab(
  history: readonly ClosedTab[],
  isOpen: (path: string) => boolean,
): { tab: ClosedTab | null; history: ClosedTab[] } {
  const next = [...history];
  while (next.length > 0) {
    const tab = next.pop()!;
    if (!isOpen(tab.path)) return { tab, history: next };
  }
  return { tab: null, history: next };
}

export function canReopenClosedTab(
  history: readonly ClosedTab[],
  isOpen: (path: string) => boolean,
): boolean {
  return history.some((tab) => !isOpen(tab.path));
}

export function closedTabKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}
