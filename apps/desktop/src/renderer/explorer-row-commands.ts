import type { KeyboardEvent } from 'react';
import type { ExplorerClipboardState, WorkspaceDirectoryEntry } from '../shared/api';

export type ExplorerRowCommand = 'copy' | 'cut' | 'paste' | 'rename' | 'delete';

type ExplorerKey = Pick<
  KeyboardEvent<HTMLElement>,
  'altKey' | 'code' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

export function explorerRowCommand(event: ExplorerKey): ExplorerRowCommand | null {
  if (event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.ctrlKey) {
    const letter = /^Key([CXV])$/u.exec(event.code)?.[1] ?? event.key.toUpperCase();
    if (letter === 'C') return 'copy';
    if (letter === 'X') return 'cut';
    if (letter === 'V') return 'paste';
    return null;
  }
  if (event.key === 'F2') return 'rename';
  if (event.key === 'Delete') return 'delete';
  return null;
}

export interface ExplorerRowTarget {
  entry: WorkspaceDirectoryEntry;
  isRoot: boolean;
  pasteTarget: WorkspaceDirectoryEntry | null;
}

export class ExplorerClipboardTracker {
  private turn = 0;

  constructor(private readonly apply: (state: ExplorerClipboardState) => void) {}

  async put(
    entryId: string,
    mode: 'copy' | 'cut',
    write: () => Promise<ExplorerClipboardState>,
  ): Promise<void> {
    const turn = ++this.turn;
    this.apply({ canPaste: true, cutEntryId: mode === 'cut' ? entryId : null });
    const state = await write();
    if (turn === this.turn) this.apply(state);
  }

  async request<T>(send: () => Promise<T>, stateOf: (answer: T) => ExplorerClipboardState) {
    const turn = ++this.turn;
    const answer = await send();
    if (turn === this.turn) this.apply(stateOf(answer));
    return answer;
  }
}

export function explorerRowCommandAllowed(
  command: ExplorerRowCommand,
  target: ExplorerRowTarget,
): boolean {
  if (command === 'copy') return true;
  if (command === 'paste') return target.pasteTarget?.writable === true;
  return target.entry.writable && !target.isRoot;
}
