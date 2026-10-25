import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import type { Clipboard, ClipboardItem } from 'electron';
import type {
  ExplorerClipboardState,
  ExplorerClipboardWriteRequest,
  ExplorerPasteRequest,
  ExplorerPasteResult,
  WorkspaceEntryKind,
  WorkspacePathChange,
} from '../shared/api';
import {
  decodeFileUriList,
  encodeFileUriList,
  maximumFileListBytes,
  tooManyItemsError,
} from './explorer-clipboard-format';
import { entryId, type WorkspaceEntryPathEvent, type WorkspaceService } from './workspace-service';

export interface ExplorerClipboardContent {
  uriList: string | null;
  marker: string | null;
}

export interface ExplorerClipboardHost {
  read(): Promise<ExplorerClipboardContent>;
  writeFileList(uriList: string, marker: string): Promise<void>;
  clear(): void;
}

export type ExplorerClipboardWorkspace = Pick<
  WorkspaceService,
  | 'clipboardEntry'
  | 'copyEntriesInto'
  | 'moveEntry'
  | 'onEntryPathsChanged'
  | 'onWorkspaceRootChange'
>;

interface HeldEntry {
  mode: 'copy' | 'cut';
  path: string;
  kind: WorkspaceEntryKind;
}

type PasteSource =
  { kind: 'external'; paths: string[] } | { kind: 'held'; entry: HeldEntry } | { kind: 'nothing' };

export class ExplorerClipboard {
  private held: HeldEntry | null = null;
  private marker: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly workspace: ExplorerClipboardWorkspace,
    private readonly host: ExplorerClipboardHost,
  ) {
    workspace.onEntryPathsChanged((event) => this.follow(event));
    workspace.onWorkspaceRootChange(() => {
      if (this.held?.mode === 'cut') this.held = null;
    });
  }

  write(request: ExplorerClipboardWriteRequest): Promise<ExplorerClipboardState> {
    return this.serialized(async () => {
      validateWriteRequest(request);
      const entry = await this.workspace.clipboardEntry(request.entryId, request.mode === 'cut');
      const marker = randomUUID();
      await this.host.writeFileList(encodeFileUriList([entry.path]), marker);
      this.held = { mode: request.mode, path: entry.path, kind: entry.kind };
      this.marker = marker;
      return this.state();
    });
  }

  currentState(): Promise<ExplorerClipboardState> {
    return this.serialized(() => this.stateNow());
  }

  paste(
    request: ExplorerPasteRequest,
    persist: (changes: WorkspacePathChange[]) => Promise<void>,
  ): Promise<ExplorerPasteResult> {
    return this.serialized(async () => {
      validatePasteRequest(request);
      const source = await this.pasteSource();
      if (source.kind === 'nothing') return this.result('nothing', null, [], [], 0);
      if (source.kind === 'external' || source.entry.mode === 'copy') {
        const { entries, skipped } = await this.workspace.copyEntriesInto(
          source.kind === 'external'
            ? source.paths.map((path) => ({ path }))
            : [{ path: source.entry.path, kind: source.entry.kind }],
          request.targetId,
        );
        return this.result('pasted', 'copy', entries, [], skipped, await this.stateNow());
      }
      const moved = await this.workspace.moveEntry(
        source.entry.path,
        source.entry.kind,
        request.targetId,
        persist,
      );
      if (moved.status === 'unchanged') return this.result('unchanged', 'move', [], [], 0);
      this.held = null;
      if ((await this.host.read()).marker === this.marker) this.host.clear();
      this.marker = null;
      return this.result(
        'pasted',
        'move',
        moved.result.entry ? [moved.result.entry] : [],
        moved.result.pathChanges,
        0,
      );
    });
  }

  private async pasteSource(): Promise<PasteSource> {
    const content = await this.host.read();
    const ours = this.marker !== null && content.marker === this.marker;
    if (content.uriList !== null && !ours) {
      const paths = decodeFileUriList(content.uriList);
      if (paths !== null) {
        this.held = null;
        this.marker = null;
        return { kind: 'external', paths };
      }
    }
    return this.held ? { kind: 'held', entry: this.held } : { kind: 'nothing' };
  }

  private state(): ExplorerClipboardState {
    return { canPaste: this.held !== null, cutEntryId: this.cutEntryId() };
  }

  private async stateNow(): Promise<ExplorerClipboardState> {
    try {
      const source = await this.pasteSource();
      return { canPaste: source.kind !== 'nothing', cutEntryId: this.cutEntryId() };
    } catch {
      return { canPaste: true, cutEntryId: this.cutEntryId() };
    }
  }

  private cutEntryId(): string | null {
    return this.held?.mode === 'cut' ? entryId(this.held.path, this.held.kind) : null;
  }

  private result(
    status: ExplorerPasteResult['status'],
    operation: ExplorerPasteResult['operation'],
    entries: ExplorerPasteResult['entries'],
    pathChanges: WorkspacePathChange[],
    skipped: number,
    state: ExplorerClipboardState = this.state(),
  ): ExplorerPasteResult {
    return { status, operation, entries, pathChanges, skipped, state };
  }

  private follow(event: WorkspaceEntryPathEvent): void {
    const held = this.held;
    if (!held) return;
    if (event.kind === 'removed') {
      if (isPathInside(held.path, event.path)) this.held = null;
      return;
    }
    const change = event.changes
      .filter((candidate) => isPathInside(held.path, candidate.oldPath))
      .sort((left, right) => right.oldPath.length - left.oldPath.length)[0];
    if (!change) return;
    const suffix = relative(pathKey(change.oldPath), pathKey(held.path));
    const tail = suffix ? held.path.slice(held.path.length - suffix.length) : '';
    this.held = { ...held, path: tail ? join(change.newPath, tail) : change.newPath };
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

function validateWriteRequest(value: ExplorerClipboardWriteRequest): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.entryId !== 'string' ||
    value.entryId.length < 1 ||
    value.entryId.length > 256 ||
    (value.mode !== 'copy' && value.mode !== 'cut')
  ) {
    throw new Error('explorer clipboard request is invalid');
  }
}

function validatePasteRequest(value: ExplorerPasteRequest): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof value.targetId !== 'string' ||
    value.targetId.length < 1 ||
    value.targetId.length > 256
  ) {
    throw new Error('explorer paste request is invalid');
  }
}

function pathKey(path: string): string {
  return path.replaceAll('/', '\\').replace(/\\+$/u, '').toLocaleLowerCase('en-US');
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const result = relative(pathKey(rootPath), pathKey(targetPath));
  return result === '' || (!result.startsWith('..') && !isAbsolute(result));
}

export const explorerClipboardMarkerFormat = 'web application/x-rmside-explorer-copy';

const maximumMarkerBytes = 64;

export function electronExplorerClipboardHost(
  clipboard: Clipboard,
  ClipboardItemClass: typeof ClipboardItem,
): ExplorerClipboardHost {
  return {
    async read() {
      if (!(await clipboard.has('text/uri-list'))) return { uriList: null, marker: null };
      const item = (await clipboard.read()).find((candidate) =>
        candidate.types.includes('text/uri-list'),
      );
      if (!item) return { uriList: null, marker: null };
      const list = await item.getType('text/uri-list');
      if (!isBlobLike(list)) return { uriList: null, marker: null };
      if (list.size > maximumFileListBytes) throw tooManyItemsError();
      let marker: string | null = null;
      if (item.types.includes(explorerClipboardMarkerFormat)) {
        const value = await item.getType(explorerClipboardMarkerFormat);
        if (isBlobLike(value) && value.size <= maximumMarkerBytes) marker = await value.text();
      }
      return { uriList: await list.text(), marker };
    },
    async writeFileList(uriList, marker) {
      await clipboard.write([
        new ClipboardItemClass({
          'text/uri-list': uriList,
          [explorerClipboardMarkerFormat]: marker,
        }),
      ]);
    },
    clear() {
      clipboard.clear();
    },
  };
}

function isBlobLike(value: unknown): value is { size: number; text(): Promise<string> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { size?: unknown }).size === 'number' &&
    typeof (value as { text?: unknown }).text === 'function'
  );
}
