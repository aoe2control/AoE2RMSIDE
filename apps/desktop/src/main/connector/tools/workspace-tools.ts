import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RootExecutionState, WorkspaceCreateRequest } from '../../../shared/api';
import {
  validateConnectorApplyEditReply,
  validateConnectorEditorStateReply,
  validateConnectorOpenBackgroundReply,
  validateConnectorSaveReply,
  type ConnectorApplyEditReply,
  type ConnectorApplyEditRequest,
  type ConnectorEditorStateReply,
} from '../../../shared/connector-workspace';
import { decodeSourceBytes } from '../../source-codec';
import {
  ConnectorToolError,
  connectorJsonText,
  type ConnectorToolContext,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';
import type { ConnectorRendererBridge } from '../renderer-bridge';
import type { ConnectorJsonValue, ConnectorToolArguments } from '../validator';
import {
  sourcePath,
  summarizeProblems,
  type ConnectorDiagnosticsStore,
  type ProblemItem,
} from '../diagnostics-store';
import {
  WorkspacePathGuard,
  isConnectorEditableName,
  isConnectorReadableName,
  isInsideRoot,
  type GuardedPath,
  type PathGuardWorkspace,
} from '../path-guard';

export interface MirroredDocument {
  uri: string;
  version: number;
  text: string;
}

export interface WorkspaceToolWorkspace extends PathGuardWorkspace {
  isReservedName(name: string): boolean;
  grantFolder(canonicalPath: string): string;
  createEntry(request: WorkspaceCreateRequest): Promise<{ targetPath: string }>;
}

export type IdeStatusPart = (
  context: ConnectorToolContext,
) => Promise<Record<string, ConnectorJsonValue> | undefined>;

export interface WorkspaceToolDependencies {
  workspace: WorkspaceToolWorkspace;
  documents: { document(uri: string): MirroredDocument | undefined };
  diagnostics: ConnectorDiagnosticsStore;
  bridge: Pick<ConnectorRendererBridge, 'request'>;
  lane(): RootExecutionState;
  gameFolderLinked(): boolean;
  now?: () => number;
  timing?: Partial<WorkspaceToolTiming>;
}

export interface WorkspaceToolTiming {
  editDiagnosticsMs: number;
  problemsDiagnosticsMs: number;
  mirrorMs: number;
  editorStateMs: number;
  applyEditMs: number;
  openMs: number;
  saveMs: number;
}

const defaultTiming: WorkspaceToolTiming = {
  editDiagnosticsMs: 1_500,
  problemsDiagnosticsMs: 2_000,
  mirrorMs: 2_000,
  editorStateMs: 3_000,
  applyEditMs: 20_000,
  openMs: 10_000,
  saveMs: 30_000,
};

const maximumListedTabs = 12;
const maximumListedDirs = 40;
const maximumListingDepth = 16;
const maximumListingEntries = 20_000;

function quoted(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function relativeOf(root: string, absolute: string): string | null {
  if (!isInsideRoot(absolute, root)) return null;
  const rest = resolve(absolute)
    .slice(resolve(root).length)
    .replace(/^[\\/]+/u, '');
  return rest.replaceAll('\\', '/');
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase('en-US') : normalized;
}

function textLength(value: object): number {
  return [...connectorJsonText(value)].length;
}

export function fitItems<T>(
  items: readonly T[],
  cap: number,
  make: (shown: readonly T[], omitted: number) => object,
): { value: object; shown: number } {
  let low = 0;
  let high = items.length;
  if (textLength(make(items, 0)) <= cap) return { value: make(items, 0), shown: items.length };
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textLength(make(items.slice(0, middle), items.length - middle)) <= cap) low = middle;
    else high = middle - 1;
  }
  return { value: make(items.slice(0, low), items.length - low), shown: low };
}

export function encodeCursor(offset: number, scope: string): string {
  return `${offset.toString(36)}-${createHash('sha256').update(scope).digest('hex').slice(0, 8)}`;
}

export function decodeCursor(cursor: ConnectorJsonValue | undefined, scope: string): number {
  if (cursor === undefined) return 0;
  const match = typeof cursor === 'string' ? /^([0-9a-z]{1,8})-([0-9a-f]{8})$/u.exec(cursor) : null;
  const hash = createHash('sha256').update(scope).digest('hex').slice(0, 8);
  if (!match || match[2] !== hash) {
    throw new ConnectorToolError('invalid_arguments', 'The cursor belongs to another listing.', {
      hint: 'Repeat the call without cursor, then use the cursor its more gives.',
    });
  }
  return Number.parseInt(match[1]!, 36);
}

function diskVersion(bytes: Uint8Array): string {
  return `d${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}`;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/u);
}

export function globMatcher(pattern: string): (relativePath: string, name: string) => boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else source += '.*';
      } else source += '[^/]*';
    } else if (character === '?') source += '[^/]';
    else if (character === '\\') source += '/';
    else source += character.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
  }
  const expression = new RegExp(`^${source}$`, 'iu');
  const onPaths = /[\\/]/u.test(pattern);
  return (relativePath, name) => expression.test(onPaths ? relativePath : name);
}

interface EditorTabs {
  active: string | null;
  documents: ConnectorEditorStateReply['documents'];
  dirty: Set<string>;
}

export function registerWorkspaceTools(
  registry: ConnectorToolRegistry,
  dependencies: WorkspaceToolDependencies,
): { addStatusPart(part: IdeStatusPart): () => void; dispose(): void } {
  const tools = new WorkspaceTools(dependencies);
  const unregister = [
    registry.register('ide_status', (args, context) => tools.ideStatus(args, context)),
    registry.register('list_files', (args, context) => tools.listFiles(args, context)),
    registry.register('read_file', (args, context) => tools.readFile(args, context)),
    registry.register('edit_file', (args, context) => tools.editFile(args, context)),
    registry.register('create_file', (args, context) => tools.createFile(args, context)),
    registry.register('save_file', (args, context) => tools.saveFile(args, context)),
    registry.register('get_problems', (args, context) => tools.getProblems(args, context)),
  ];
  return {
    addStatusPart: (part) => tools.addStatusPart(part),
    dispose: () => {
      for (const remove of unregister) remove();
    },
  };
}

export class WorkspaceTools {
  private readonly guard: WorkspacePathGuard;
  private readonly timing: WorkspaceToolTiming;
  private readonly statusParts: IdeStatusPart[] = [];
  private readonly now: () => number;

  constructor(private readonly dependencies: WorkspaceToolDependencies) {
    this.guard = new WorkspacePathGuard(dependencies.workspace);
    this.timing = { ...defaultTiming, ...dependencies.timing };
    this.now = dependencies.now ?? Date.now;
  }

  addStatusPart(part: IdeStatusPart): () => void {
    this.statusParts.push(part);
    return () => {
      const index = this.statusParts.indexOf(part);
      if (index >= 0) this.statusParts.splice(index, 1);
    };
  }

  async ideStatus(
    _args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const cap = context.tool.output.maxChars;
    const rootPath = this.dependencies.workspace.root();
    let root: string | null = null;
    if (rootPath) {
      try {
        root = await this.guard.root();
      } catch {
        root = null;
      }
    }
    const tabs = await this.editorTabs(context.signal);
    const lane = this.laneState();
    const parts: Record<string, ConnectorJsonValue> = {};
    for (const part of [...this.statusParts]) {
      try {
        Object.assign(parts, (await part(context)) ?? {});
      } catch {}
    }
    const open: { path: string; unsaved?: true; app_edits?: true }[] = [];
    let outsideTabs = 0;
    for (const document of tabs?.documents ?? []) {
      const relativePath = root ? relativeOf(root, document.path) : null;
      if (relativePath === null) {
        outsideTabs += 1;
        continue;
      }
      open.push({
        path: relativePath,
        ...(document.dirty ? { unsaved: true as const } : {}),
        ...(document.appEdits ? { app_edits: true as const } : {}),
      });
    }
    const active = root && tabs?.active ? relativeOf(root, tabs.active) : null;
    const make = (shown: readonly (typeof open)[number][], omitted: number) => ({
      folder: root ? (root.split(/[\\/]/u).filter(Boolean).at(-1) ?? root) : undefined,
      ...(root
        ? {}
        : {
            note: 'No folder is open. Open a recent one with list_folders and open_folder, or ask the user to open their scripts folder.',
          }),
      active: active ?? undefined,
      open: shown,
      ...(parts.run === undefined ? {} : { run: parts.run }),
      lane,
      saving: context.settings.allowSaving ? 'on' : 'off',
      ...Object.fromEntries(Object.entries(parts).filter(([key]) => key !== 'run')),
      game_folder: this.dependencies.gameFolderLinked(),
      ...(omitted > 0 || outsideTabs > 0
        ? {
            more: {
              ...(omitted > 0 ? { tabs: omitted } : {}),
              ...(outsideTabs > 0 ? { outside_folder_tabs: outsideTabs } : {}),
            },
          }
        : {}),
      ...(tabs ? {} : { tabs: 'unknown (the IDE window did not answer)' }),
    });
    const limited = open.slice(0, maximumListedTabs);
    const { value } = fitItems(limited, cap, (shown, omitted) =>
      make(shown, omitted + (open.length - limited.length)),
    );
    return { content: [{ type: 'text', text: connectorJsonText(value) }] };
  }

  private laneState(): Record<string, ConnectorJsonValue> {
    const state = this.dependencies.lane();
    if (state.phase === 'idle') return { state: 'idle' };
    return {
      state: state.phase,
      ...(state.kind ? { kind: state.kind } : {}),
      ...(state.label ? { label: [...state.label].slice(0, 80).join('') } : {}),
      ...(state.startedAt
        ? { elapsed_s: Math.max(0, Math.round((this.now() - state.startedAt) / 100) / 10) }
        : {}),
    };
  }

  async listFiles(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const dirArgument = typeof args.dir === 'string' ? args.dir : '';
    const pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 100;
    const folder = await this.guard.resolve(dirArgument, 'folder');
    const shownDir = folder.relative === '' ? '.' : folder.relative;
    const scope = `list\u0000${folder.relative.toLowerCase()}\u0000${pattern ?? ''}`;
    const offset = decodeCursor(args.cursor, scope);
    const matches = pattern ? globMatcher(pattern) : () => true;
    const walk = await this.walk(folder, matches, context.signal);
    const page = walk.files.slice(offset, offset + limit);
    const tabs = await this.editorTabs(context.signal);
    const listed: { p: string; kb: number; unsaved?: true }[] = [];
    for (const file of page) {
      let size = 0;
      try {
        size = (await lstat(file.absolute)).size;
      } catch {
        continue;
      }
      listed.push({
        p: file.relative,
        kb: size === 0 ? 0 : Math.max(1, Math.round(size / 1024)),
        ...(tabs?.dirty.has(pathKey(file.absolute)) ? { unsaved: true as const } : {}),
      });
    }
    const dirs = offset === 0 ? walk.dirs.slice(0, maximumListedDirs) : [];
    const cap = context.tool.output.maxChars;
    const { value } = fitItems(listed, cap, (shown) => {
      const remaining = walk.files.length - offset - shown.length;
      const nextOffset = offset + shown.length;
      const more =
        remaining > 0
          ? {
              files: remaining,
              ask: `list_files {${dirArgument ? `dir:${quoted(folder.relative)}, ` : ''}${
                pattern ? `pattern:${quoted(pattern)}, ` : ''
              }cursor:'${encodeCursor(nextOffset, scope)}'}`,
            }
          : undefined;
      return {
        dir: shownDir,
        files: shown,
        dirs,
        ...(walk.dirs.length > dirs.length && offset === 0
          ? { more_dirs: walk.dirs.length - dirs.length }
          : {}),
        ...(walk.truncated
          ? { note: 'The folder is very large; only part of it was listed.' }
          : {}),
        ...(more ? { more } : {}),
      };
    });
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { count: listed.length },
    };
  }

  private async walk(
    folder: GuardedPath,
    matches: (relativePath: string, name: string) => boolean,
    signal: AbortSignal,
  ): Promise<{
    files: { relative: string; absolute: string }[];
    dirs: string[];
    truncated: boolean;
  }> {
    const files: { relative: string; absolute: string }[] = [];
    const dirs: string[] = [];
    let visited = 0;
    let truncated = false;
    const workspace = this.dependencies.workspace;
    const visit = async (absolute: string, relativePath: string, depth: number): Promise<void> => {
      if (signal.aborted) throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      let entries: Dirent[];
      try {
        entries = await readdir(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        visited += 1;
        if (visited > maximumListingEntries) {
          truncated = true;
          return;
        }
        const name = entry.name;
        const childAbsolute = join(absolute, name);
        const childRelative = relativePath ? `${relativePath}/${name}` : name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (name.startsWith('.') || workspace.isProtected(childAbsolute)) continue;
          try {
            const info = await lstat(childAbsolute);
            if (info.isSymbolicLink()) continue;
            if (pathKey(await realpath(childAbsolute)) !== pathKey(childAbsolute)) continue;
          } catch {
            continue;
          }
          if (depth === 0) dirs.push(childRelative);
          if (depth + 1 < maximumListingDepth) await visit(childAbsolute, childRelative, depth + 1);
          else truncated = true;
        } else if (entry.isFile() && isConnectorReadableName(name)) {
          const belowFolder = childRelative;
          if (!matches(belowFolder, name)) continue;
          files.push({
            relative: folder.relative ? `${folder.relative}/${childRelative}` : childRelative,
            absolute: childAbsolute,
          });
        }
      }
    };
    await visit(folder.absolute, '', 0);
    const order = (left: string, right: string) => {
      const a = left.toLowerCase();
      const b = right.toLowerCase();
      return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
    };
    files.sort((left, right) => order(left.relative, right.relative));
    dirs.sort(order);
    return {
      files,
      dirs: dirs.map((entry) => (folder.relative ? `${folder.relative}/${entry}` : entry)),
      truncated,
    };
  }

  async readFile(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const path = await this.guard.resolve(String(args.path), 'file');
    const startLine = typeof args.start_line === 'number' ? args.start_line : 1;
    const lineCount = typeof args.lines === 'number' ? args.lines : 400;
    const numbers = args.numbers === true;
    const open = this.mirrored(path);
    let text: string;
    let version: string;
    let unsaved: boolean | undefined;
    if (open) {
      text = open.text;
      version = `v${open.version}`;
      const tabs = await this.editorTabs(context.signal);
      unsaved = tabs ? tabs.dirty.has(pathKey(path.absolute)) : undefined;
    } else {
      const bytes = await this.guard.read(path);
      version = diskVersion(bytes);
      text = decodeSourceBytes(bytes).content;
    }
    const lines = splitLines(text);
    const total = lines.length;
    const first = Math.min(startLine, total + 1);
    const cap = context.tool.output.maxChars;
    const wanted = lines.slice(first - 1, first - 1 + lineCount);
    const rendered = wanted.map((line, index) => (numbers ? `${first + index}\t${line}` : line));
    const make = (shownLines: readonly string[], cutLine?: string) => {
      const shownCount = shownLines.length + (cutLine === undefined ? 0 : 1);
      const last = first + shownCount - 1;
      const nextLine = last + 1;
      const remaining = total - last;
      return {
        path: path.relative,
        version,
        lines: shownCount === 0 ? '' : `${first}-${last}`,
        total_lines: total,
        ...(unsaved ? { unsaved: true } : {}),
        text: [...shownLines, ...(cutLine === undefined ? [] : [cutLine])].join('\n'),
        ...(cutLine === undefined ? {} : { cut: `line ${last} is cut at the size limit` }),
        ...(startLine > total ? { note: `start_line is after the last line (${total})` } : {}),
        ...(remaining > 0 && shownCount > 0
          ? {
              more: {
                lines: remaining,
                ask: `read_file {path:${quoted(path.relative)}, start_line:${nextLine}}`,
              },
            }
          : {}),
      };
    };
    let { value, shown } = fitItems(rendered, cap, (shownLines) => make(shownLines));
    if (shown === 0 && rendered.length > 0) {
      const line = [...rendered[0]!];
      let low = 0;
      let high = line.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (textLength(make([], line.slice(0, middle).join(''))) <= cap) low = middle;
        else high = middle - 1;
      }
      value = make([], line.slice(0, low).join(''));
      shown = 1;
    }
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { file: path.relative },
    };
  }

  async editFile(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const path = await this.guard.resolve(String(args.path), 'file', { editable: true });
    const edits = (
      args.edits as readonly { old_text: string; new_text: string; all?: boolean }[]
    ).map((edit) => ({ oldText: edit.old_text, newText: edit.new_text, all: edit.all === true }));
    const request: ConnectorApplyEditRequest = {
      appName: context.app.displayName.slice(0, 128) || context.app.name,
      path: path.absolute,
      edits,
      ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
    };
    const open = this.mirrored(path);
    const base = typeof args.base_version === 'string' ? args.base_version : undefined;
    if (base?.startsWith('v')) {
      const baseVersion = Number.parseInt(base.slice(1), 10);
      if (!open || open.version !== baseVersion) {
        throw this.moved(path, open ? `v${open.version}` : undefined);
      }
      request.baseVersion = baseVersion;
    } else if (base?.startsWith('d')) {
      request.baseDiskHash = base.slice(1);
      if (!open) {
        const bytes = await this.guard.read(path);
        const current = diskVersion(bytes);
        if (!current.slice(1).startsWith(request.baseDiskHash.slice(0, 16))) {
          throw this.moved(path, current);
        }
      }
    }
    if (!open) await this.guard.read(path);
    const reply = await this.applyEdit(request, context);
    return this.editAnswer(path, reply, edits.length, context, false);
  }

  private moved(path: GuardedPath, version: string | undefined): ConnectorToolError {
    return new ConnectorToolError('edit_conflict', `${path.relative} changed since base_version.`, {
      hint: 'Read the part you want to change again with read_file, then edit it.',
      ...(version ? { details: { version } } : {}),
    });
  }

  private async applyEdit(
    request: ConnectorApplyEditRequest,
    context: ConnectorToolContext,
  ): Promise<ConnectorApplyEditReply> {
    const raw = await this.dependencies.bridge.request('applyEdit', request, {
      timeoutMilliseconds: this.timing.applyEditMs,
      signal: context.signal,
    });
    try {
      return validateConnectorApplyEditReply(raw);
    } catch {
      throw new ConnectorToolError('internal', 'The AoE2RMSIDE window gave an unexpected answer.');
    }
  }

  private async editAnswer(
    path: GuardedPath,
    reply: ConnectorApplyEditReply,
    editCount: number,
    context: ConnectorToolContext,
    created: boolean,
  ): Promise<ConnectorToolResult> {
    if (reply.status === 'conflict') {
      const which = editCount > 1 ? `Edit ${reply.edit + 1}: ` : '';
      const version = reply.version === null ? undefined : `v${reply.version}`;
      const details: Record<string, ConnectorJsonValue> = {
        ...(version ? { version } : {}),
        ...(reply.nearest.length > 0
          ? { nearest: reply.nearest.map((line) => ({ line: line.line, text: line.text })) }
          : {}),
      };
      const [message, hint] =
        reply.reason === 'not-found'
          ? [
              `${which}old_text was not found in ${path.relative}.`,
              'Copy old_text character for character from read_file (without line numbers); nearest shows similar lines.',
            ]
          : reply.reason === 'ambiguous'
            ? [
                `${which}old_text occurs ${reply.count ?? 2} times in ${path.relative}.`,
                'Add neighbouring lines to old_text so it occurs once, or set all to replace every occurrence.',
              ]
            : reply.reason === 'too-many'
              ? [
                  `${which}old_text occurs ${reply.count ?? 201} times; all replaces at most 200.`,
                  'Split the change into smaller edits.',
                ]
              : reply.reason === 'overlap'
                ? [
                    `${which}this edit overlaps another edit of the same call.`,
                    'Merge overlapping edits into one.',
                  ]
                : [
                    `${path.relative} changed since base_version.`,
                    'Read the part you want to change again with read_file, then edit it.',
                  ];
      throw new ConnectorToolError('edit_conflict', message, { hint, details });
    }
    const document = await this.waitForMirror(path, reply.version, context.signal);
    const version = document
      ? `v${document.version}`
      : reply.version === null
        ? undefined
        : `v${reply.version}`;
    const problems = document
      ? await this.editProblems(document, context.signal)
      : ('pending' as const);
    const lines =
      reply.endLine > reply.startLine
        ? `lines ${reply.startLine}-${reply.endLine}`
        : `line ${reply.startLine}`;
    const delta =
      reply.lineDelta > 0
        ? ` (+${reply.lineDelta})`
        : reply.lineDelta < 0
          ? ` (${reply.lineDelta})`
          : '';
    const value = {
      path: path.relative,
      version,
      ...(created ? {} : { changed: `${lines}${delta}` }),
      problems,
    };
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { file: path.relative },
    };
  }

  private async editProblems(
    document: MirroredDocument,
    signal: AbortSignal,
  ): Promise<Record<string, ConnectorJsonValue> | 'pending'> {
    const analyzed = await this.dependencies.diagnostics.waitForVersion(
      document.uri,
      document.version,
      this.timing.editDiagnosticsMs,
      signal,
    );
    if (!analyzed) return 'pending';
    const summary = summarizeProblems({
      uri: document.uri,
      sources: this.dependencies.diagnostics.all(),
      xsFindings: [],
      severity: 'warnings',
    });
    const errors = summary.items.filter((item) => item.sev === 'error');
    const first = (errors.length > 0 ? errors : summary.items).slice(0, 3);
    return {
      errors: summary.counts.errors,
      warnings: summary.counts.warnings,
      first: first.map((item) => ({ line: item.line, code: item.code, msg: item.msg })),
      ...(summary.includes.length > 0
        ? { include_errors: summary.includes.reduce((total, include) => total + include.errors, 0) }
        : {}),
    };
  }

  private async waitForMirror(
    path: GuardedPath,
    version: number | null,
    signal: AbortSignal,
  ): Promise<MirroredDocument | undefined> {
    const deadline = Date.now() + this.timing.mirrorMs;
    for (;;) {
      const document = this.mirrored(path);
      if (document && (version === null || document.version >= version)) return document;
      if (signal.aborted) throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      if (Date.now() >= deadline) return document;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
  }

  async createFile(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const path = await this.guard.resolve(String(args.path), 'new-file', {
      editable: true,
      maximumNewFolders: 2,
    });
    const content = typeof args.content === 'string' ? args.content : '';
    const openTab = args.open !== false;
    const name = path.segments.at(-1)!;
    const workspace = this.dependencies.workspace;
    if (workspace.isReservedName(name)) {
      throw new ConnectorToolError(
        'outside_workspace',
        `${name} is the name of a standard game file; a script with this name would hide it.`,
        { hint: 'Choose another file name.' },
      );
    }
    let parent = path.root;
    for (const segment of path.segments.slice(0, path.existingSegments))
      parent = join(parent, segment);
    for (const segment of path.segments.slice(path.existingSegments, -1)) {
      await this.assertNameFree(parent, segment, path);
      await this.create(
        { parentId: workspace.grantFolder(parent), kind: 'folder', name: segment },
        path,
      );
      parent = join(parent, segment);
    }
    await this.assertNameFree(parent, name, path);
    const created = await this.create(
      { parentId: workspace.grantFolder(parent), kind: 'file', name },
      path,
    );
    const createdPath: GuardedPath = { ...path, absolute: created.targetPath, stats: null };
    if (content.length > 0) {
      const reply = await this.applyEdit(
        {
          appName: context.app.displayName.slice(0, 128) || context.app.name,
          path: created.targetPath,
          content,
        },
        context,
      );
      const answer = await this.editAnswer(createdPath, reply, 1, context, true);
      if (!openTab) {
        const value = JSON.parse((answer.content[0] as { text: string }).text) as object;
        return {
          content: [
            {
              type: 'text',
              text: connectorJsonText({
                ...value,
                note: 'Opened in a background tab anyway: unsaved content lives in a tab.',
              }),
            },
          ],
          facts: { file: path.relative },
        };
      }
      return answer;
    }
    if (!openTab) {
      return {
        content: [
          {
            type: 'text',
            text: connectorJsonText({
              path: path.relative,
              version: diskVersion(new Uint8Array()),
            }),
          },
        ],
        facts: { file: path.relative },
      };
    }
    await this.openBackground(created.targetPath, context);
    const document = await this.waitForMirror(createdPath, null, context.signal);
    return {
      content: [
        {
          type: 'text',
          text: connectorJsonText({
            path: path.relative,
            version: document ? `v${document.version}` : diskVersion(new Uint8Array()),
          }),
        },
      ],
      facts: { file: path.relative },
    };
  }

  private async assertNameFree(parent: string, name: string, path: GuardedPath): Promise<void> {
    let names: string[];
    try {
      names = await readdir(parent);
    } catch {
      throw new ConnectorToolError('not_found', `The folder for ${path.relative} cannot be read.`);
    }
    const key = name.toLocaleLowerCase('en-US');
    if (names.some((entry) => entry.toLocaleLowerCase('en-US') === key)) {
      throw new ConnectorToolError('already_exists', `${path.relative} already exists.`, {
        hint: 'Use edit_file to change it, or choose another name.',
      });
    }
  }

  private async create(
    request: WorkspaceCreateRequest,
    path: GuardedPath,
  ): Promise<{ targetPath: string }> {
    try {
      return await this.dependencies.workspace.createEntry(request);
    } catch {
      throw new ConnectorToolError('internal', `AoE2RMSIDE could not create ${path.relative}.`, {
        hint: 'Check that the folder is writable, or ask the user to create the file.',
      });
    }
  }

  private async openBackground(absolute: string, context: ConnectorToolContext): Promise<boolean> {
    const raw = await this.dependencies.bridge.request(
      'openBackground',
      { path: absolute },
      { timeoutMilliseconds: this.timing.openMs, signal: context.signal },
    );
    try {
      return validateConnectorOpenBackgroundReply(raw).opened;
    } catch {
      throw new ConnectorToolError('internal', 'The AoE2RMSIDE window gave an unexpected answer.');
    }
  }

  async saveFile(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    if (!context.settings.allowSaving) {
      throw new ConnectorToolError('saving_off', 'Saving by AI apps is turned off in AoE2RMSIDE.', {
        hint: 'Ask the user to save (Ctrl+S), or to turn on Let AI apps save files in View > MCP.',
      });
    }
    const path = await this.guard.resolve(String(args.path), 'file', { editable: true });
    const raw = await this.dependencies.bridge.request(
      'save',
      { path: path.absolute },
      { timeoutMilliseconds: this.timing.saveMs, signal: context.signal },
    );
    let status: string;
    try {
      status = validateConnectorSaveReply(raw).status;
    } catch {
      throw new ConnectorToolError('internal', 'The AoE2RMSIDE window gave an unexpected answer.');
    }
    if (status === 'failed') {
      throw new ConnectorToolError('internal', `AoE2RMSIDE could not save ${path.relative}.`, {
        hint: 'Ask the user to look at the Output in AoE2RMSIDE and save the file.',
      });
    }
    const value =
      status === 'saved'
        ? { path: path.relative, saved: true }
        : {
            path: path.relative,
            saved: false,
            note:
              status === 'clean'
                ? 'The tab has no unsaved changes.'
                : 'The file is not open in the editor, so nothing is unsaved.',
          };
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { file: path.relative },
    };
  }

  async getProblems(
    args: ConnectorToolArguments,
    context: ConnectorToolContext,
  ): Promise<ConnectorToolResult> {
    const path = await this.guard.resolve(String(args.path), 'file');
    const severity =
      args.severity === 'errors' || args.severity === 'all' ? args.severity : 'warnings';
    const code = typeof args.code === 'string' ? args.code : undefined;
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const scope = `problems\u0000${path.relative.toLowerCase()}\u0000${severity}\u0000${code ?? ''}`;
    const offset = decodeCursor(args.cursor, scope);
    let document = this.mirrored(path);
    let opened = false;
    if (!document && isConnectorEditableName(path.relative)) {
      opened = await this.openBackground(path.absolute, context);
      document = await this.waitForMirror(path, null, context.signal);
    }
    const analyzed = document
      ? await this.dependencies.diagnostics.waitForVersion(
          document.uri,
          document.version,
          this.timing.problemsDiagnosticsMs,
          context.signal,
        )
      : false;
    const uri = document?.uri ?? pathToFileURL(path.absolute).href;
    const store = this.dependencies.diagnostics;
    const summary = summarizeProblems({
      uri,
      sources: store.all(),
      xsFindings: store.xsFindingsIn(uri),
      severity,
      ...(code ? { code } : {}),
    });
    const xs = store.xsStart(uri);
    const includes = summary.includes.slice(0, 5).map((include) => ({
      path: this.shownSource(path.root, include.uri),
      errors: include.errors,
    }));
    const page = summary.items.slice(offset, offset + limit);
    const cap = context.tool.output.maxChars;
    const { value } = fitItems(page, cap, (shown: readonly ProblemItem[]) => {
      const remaining = summary.items.length - offset - shown.length;
      return {
        path: path.relative,
        version: document ? `v${document.version}` : undefined,
        counts: summary.counts,
        items: shown,
        includes,
        ...(xs
          ? { xs: { errors: xs.errors, warnings: xs.warnings, note: 'from the last generation' } }
          : {}),
        ...(document && !analyzed ? { analysis: 'pending' } : {}),
        ...(!document ? { note: 'This file type is not analyzed.' } : {}),
        ...(opened ? { opened: 'in a background tab, so it is analyzed' } : {}),
        ...(remaining > 0
          ? {
              more: {
                items: remaining,
                ask: `get_problems {path:${quoted(path.relative)}${
                  severity === 'warnings' ? '' : `, severity:'${severity}'`
                }${code ? `, code:${quoted(code)}` : ''}, cursor:'${encodeCursor(
                  offset + shown.length,
                  scope,
                )}'}`,
              },
            }
          : {}),
      };
    });
    return {
      content: [{ type: 'text', text: connectorJsonText(value) }],
      facts: { file: path.relative },
    };
  }

  private shownSource(root: string, uri: string): string {
    const absolute = sourcePath(uri);
    if (absolute) {
      const relativePath = relativeOf(root, absolute);
      return relativePath ?? absolute.split(/[\\/]/u).at(-1) ?? 'an include';
    }
    return uri.split(/[\\/]/u).at(-1)?.slice(0, 64) ?? 'an include';
  }

  private mirrored(path: GuardedPath): MirroredDocument | undefined {
    return this.dependencies.documents.document(pathToFileURL(path.absolute).href);
  }

  private async editorTabs(signal: AbortSignal): Promise<EditorTabs | null> {
    try {
      const raw = await this.dependencies.bridge.request(
        'editorState',
        {},
        { timeoutMilliseconds: this.timing.editorStateMs, signal },
      );
      const state = validateConnectorEditorStateReply(raw);
      return {
        active: state.active,
        documents: state.documents,
        dirty: new Set(
          state.documents
            .filter((document) => document.dirty)
            .map((document) => pathKey(document.path)),
        ),
      };
    } catch (error) {
      if (signal.aborted) throw new ConnectorToolError('cancelled', 'The call was cancelled.');
      if (error instanceof ConnectorToolError && error.code === 'cancelled') throw error;
      return null;
    }
  }
}
