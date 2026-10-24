import type {
  ConnectorErrorCode,
  ConnectorRendererReply,
  ConnectorRendererRequest,
} from '../shared/connector-api';
import {
  connectorWorkspaceLimits,
  validateConnectorApplyEditRequest,
  validateConnectorEditorStateRequest,
  validateConnectorPathRequest,
  type AppTextEdit,
  type ConnectorApplyEditReply,
  type ConnectorEditConflictReason,
  type ConnectorEditorStateReply,
  type ConnectorNearestLine,
  type ConnectorSaveReply,
} from '../shared/connector-workspace';

export interface AppEditRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface AppEditModel {
  getValue(): string;
  getEOL(): string;
  getPositionAt(offset: number): { lineNumber: number; column: number };
  pushStackElement(): void;
  pushEditOperations(
    beforeCursorState: null,
    editOperations: { range: AppEditRange; text: string }[],
    cursorStateComputer: () => null,
  ): unknown;
  getAlternativeVersionId(): number;
  deltaDecorations(
    oldDecorations: string[],
    newDecorations: {
      range: AppEditRange;
      options: { isWholeLine: boolean; className: string; description: string };
    }[],
  ): string[];
  isDisposed(): boolean;
}

export interface AppEditDocument {
  id: string;
  path: string | null;
  dirty: boolean;
  readOnly: boolean;
  diskHash: string | null;
}

export interface AppEditHost {
  documents(): readonly AppEditDocument[];
  activeDocumentId(): string;
  openBackground(path: string): Promise<string | null>;
  model(documentId: string): AppEditModel | null;
  languageVersion(documentId: string): number | null;
  waitForSync(documentId: string): Promise<void>;
  save(documentId: string): Promise<void>;
}

export interface AppEditMark {
  app: string;
  reason?: string;
}

export interface AppEditTiming {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  setTimer(callback: () => void, milliseconds: number): unknown;
  typingQuietMs: number;
  typingMaxWaitMs: number;
  highlightMs: number;
  modelWaitMs: number;
}

export const appEditLineClass = 'app-edit-line';

export interface AppReplacement {
  start: number;
  end: number;
  text: string;
  edit: number;
}

export type AppEditResolution =
  | { ok: true; replacements: AppReplacement[] }
  | {
      ok: false;
      reason: ConnectorEditConflictReason;
      edit: number;
      count?: number;
      nearest: ConnectorNearestLine[];
    };

export function normalizeLineEndings(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/gu, eol);
}

function occurrences(text: string, needle: string, limit: number): number[] {
  const found: number[] = [];
  let from = 0;
  while (found.length <= limit) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    found.push(index);
    from = index + needle.length;
  }
  return found;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) index += 1;
      starts.push(index + 1);
    } else if (code === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

function clipLine(line: string): string {
  const characters = [...line];
  return characters.length <= connectorWorkspaceLimits.lineText
    ? line
    : characters.slice(0, connectorWorkspaceLimits.lineText).join('');
}

function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase();
}

export function nearestLines(text: string, needle: string): ConnectorNearestLine[] {
  const target = collapse(
    needle.split(/\r\n|\r|\n/u).find((line) => line.trim().length > 0) ?? needle,
  );
  if (!target) return [];
  const words = new Set(target.split(/[^\p{L}\p{N}_]+/u).filter((word) => word.length >= 2));
  const scored: { line: number; text: string; score: number }[] = [];
  text.split(/\r\n|\r|\n/u).forEach((line, index) => {
    const value = collapse(line);
    if (!value) return;
    let score = 0;
    if (value === target) score = 100;
    else if (value.includes(target) || (value.length >= 8 && target.includes(value))) score = 80;
    else if (words.size > 0) {
      const shared = new Set(value.split(/[^\p{L}\p{N}_]+/u).filter((word) => words.has(word)))
        .size;
      if (shared / words.size >= 0.5) score = Math.round((shared / words.size) * 60);
    }
    if (score > 0) scored.push({ line: index + 1, text: clipLine(line), score });
  });
  return scored
    .sort((left, right) => right.score - left.score || left.line - right.line)
    .slice(0, connectorWorkspaceLimits.nearestLines)
    .map(({ line, text: lineText }) => ({ line, text: lineText }));
}

export function resolveAppEdits(
  text: string,
  eol: string,
  edits: readonly AppTextEdit[],
): AppEditResolution {
  const limit = connectorWorkspaceLimits.occurrences;
  const replacements: AppReplacement[] = [];
  const starts = lineStarts(text);
  for (const [index, edit] of edits.entries()) {
    const needle = normalizeLineEndings(edit.oldText, eol);
    const replacement = normalizeLineEndings(edit.newText, eol);
    const found = occurrences(text, needle, edit.all ? limit : 1_000);
    if (found.length === 0) {
      return { ok: false, reason: 'not-found', edit: index, nearest: nearestLines(text, needle) };
    }
    if (!edit.all && found.length > 1) {
      return {
        ok: false,
        reason: 'ambiguous',
        edit: index,
        count: found.length,
        nearest: found.slice(0, connectorWorkspaceLimits.nearestLines).map((offset) => {
          const line = lineAt(starts, offset);
          const lineEnd = starts[line] ?? text.length;
          return {
            line,
            text: clipLine(text.slice(starts[line - 1]!, lineEnd).replace(/\r?\n$|\r$/u, '')),
          };
        }),
      };
    }
    if (found.length > limit) {
      return { ok: false, reason: 'too-many', edit: index, count: found.length, nearest: [] };
    }
    for (const offset of found) {
      replacements.push({
        start: offset,
        end: offset + needle.length,
        text: replacement,
        edit: index,
      });
    }
  }
  replacements.sort((left, right) => left.start - right.start || left.edit - right.edit);
  for (let index = 1; index < replacements.length; index += 1) {
    const previous = replacements[index - 1]!;
    const current = replacements[index]!;
    if (current.start < previous.end) {
      return {
        ok: false,
        reason: 'overlap',
        edit: Math.max(previous.edit, current.edit),
        nearest: [],
      };
    }
  }
  return { ok: true, replacements };
}

export interface AppChange {
  text: string;
  ranges: { startLine: number; endLine: number }[];
  startLine: number;
  endLine: number;
  lineDelta: number;
}

export function applyReplacements(
  text: string,
  replacements: readonly AppReplacement[],
): AppChange {
  let result = '';
  let cursor = 0;
  const spans: { start: number; length: number }[] = [];
  for (const replacement of replacements) {
    result += text.slice(cursor, replacement.start);
    spans.push({ start: result.length, length: replacement.text.length });
    result += replacement.text;
    cursor = replacement.end;
  }
  result += text.slice(cursor);
  const starts = lineStarts(result);
  const ranges = spans.map((span) => {
    const startLine = lineAt(starts, span.start);
    const endLine = span.length === 0 ? startLine : lineAt(starts, span.start + span.length - 1);
    return { startLine, endLine: Math.max(startLine, endLine) };
  });
  return {
    text: result,
    ranges,
    startLine: Math.min(...ranges.map((range) => range.startLine)),
    endLine: Math.max(...ranges.map((range) => range.endLine)),
    lineDelta: starts.length - lineStarts(text).length,
  };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

class BridgeError extends Error {
  constructor(
    readonly code: ConnectorErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface MarkState extends AppEditMark {
  baseline: number;
  hidden: boolean;
}

export class AppEditBridge {
  private readonly states = new Map<string, MarkState>();
  private readonly lastUserChange = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, AppEditMark> = new Map();
  private applying: string | null = null;
  private readonly timing: AppEditTiming;

  constructor(
    private readonly host: AppEditHost,
    timing: Partial<AppEditTiming> = {},
  ) {
    this.timing = {
      now: () => Date.now(),
      sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
      setTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
      typingQuietMs: 1_500,
      typingMaxWaitMs: 5_000,
      highlightMs: 4_000,
      modelWaitMs: 5_000,
      ...timing,
    };
  }

  readonly marks = (): ReadonlyMap<string, AppEditMark> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  contentChanged(documentId: string, event: { isUndoing: boolean; isRedoing: boolean }): void {
    if (this.applying === documentId) return;
    this.lastUserChange.set(documentId, this.timing.now());
    const state = this.states.get(documentId);
    const model = this.host.model(documentId);
    if (!state || !model) return;
    const alternative = model.getAlternativeVersionId();
    if (alternative <= state.baseline) {
      if (!state.hidden) {
        state.hidden = true;
        this.publish();
      }
    } else if (state.hidden) {
      if (event.isRedoing) state.hidden = false;
      else if (!event.isUndoing) this.states.delete(documentId);
      this.publish();
    }
  }

  syncDocuments(documents: readonly AppEditDocument[]): void {
    const byId = new Map(documents.map((document) => [document.id, document]));
    let changed = false;
    for (const id of [...this.states.keys()]) {
      const document = byId.get(id);
      if (!document || !document.dirty) {
        this.states.delete(id);
        changed = true;
      }
    }
    for (const id of [...this.lastUserChange.keys()]) {
      if (!byId.has(id)) this.lastUserChange.delete(id);
    }
    if (changed) this.publish();
  }

  async handle(request: ConnectorRendererRequest): Promise<ConnectorRendererReply | null> {
    const kinds = ['applyEdit', 'openBackground', 'save', 'editorState'];
    if (!kinds.includes(request.kind)) return null;
    try {
      let payload: unknown;
      if (request.kind === 'applyEdit') payload = await this.applyEdit(request.payload);
      else if (request.kind === 'openBackground')
        payload = await this.openBackground(request.payload);
      else if (request.kind === 'save') payload = await this.save(request.payload);
      else payload = this.editorState(request.payload);
      return { requestId: request.requestId, ok: true, payload };
    } catch (error) {
      const code: ConnectorErrorCode = error instanceof BridgeError ? error.code : 'internal';
      const message =
        error instanceof BridgeError ? error.message : 'The editor could not handle the request.';
      return { requestId: request.requestId, ok: false, error: { code, message } };
    }
  }

  editorState(payload: unknown): ConnectorEditorStateReply {
    validateConnectorEditorStateRequest(payload);
    const documents = this.host.documents();
    const active = documents.find((document) => document.id === this.host.activeDocumentId());
    return {
      active: active?.path ?? null,
      documents: documents
        .filter(
          (document): document is AppEditDocument & { path: string } => document.path !== null,
        )
        .slice(0, connectorWorkspaceLimits.documents)
        .map((document) => ({
          path: document.path,
          dirty: document.dirty,
          appEdits: this.snapshot.has(document.id),
          readOnly: document.readOnly,
        })),
    };
  }

  private findDocument(path: string): AppEditDocument | undefined {
    const key = pathKey(path);
    return this.host
      .documents()
      .find((document) => document.path !== null && pathKey(document.path) === key);
  }

  private async openBackground(payload: unknown): Promise<{ opened: boolean }> {
    const { path } = validateConnectorPathRequest(payload);
    if (this.findDocument(path)) return { opened: false };
    const id = await this.host.openBackground(path);
    if (!id) throw new BridgeError('not_found', 'The file could not be opened in the editor.');
    return { opened: true };
  }

  private async save(payload: unknown): Promise<ConnectorSaveReply> {
    const { path } = validateConnectorPathRequest(payload);
    const document = this.findDocument(path);
    if (!document) return { status: 'not-open' };
    if (document.readOnly) return { status: 'failed' };
    if (!document.dirty) return { status: 'clean' };
    await this.host.save(document.id);
    return { status: this.findDocument(path)?.dirty === false ? 'saved' : 'failed' };
  }

  private async documentModel(path: string): Promise<{ id: string; model: AppEditModel }> {
    let id = this.findDocument(path)?.id;
    if (!id) {
      id = (await this.host.openBackground(path)) ?? undefined;
      if (!id) throw new BridgeError('not_found', 'The file could not be opened in the editor.');
    }
    const document = this.host.documents().find((entry) => entry.id === id);
    if (document?.readOnly) {
      throw new BridgeError('outside_workspace', 'This file is read-only in the editor.');
    }
    const deadline = this.timing.now() + this.timing.modelWaitMs;
    for (;;) {
      const model = this.host.model(id);
      if (model && !model.isDisposed()) return { id, model };
      if (this.timing.now() >= deadline) {
        throw new BridgeError('internal', 'The editor did not open the file in time.');
      }
      await this.timing.sleep(16);
    }
  }

  private async typingPause(documentId: string): Promise<void> {
    const started = this.timing.now();
    for (;;) {
      const last = this.lastUserChange.get(documentId);
      const now = this.timing.now();
      const quiet = last === undefined ? Number.POSITIVE_INFINITY : now - last;
      const waited = now - started;
      if (quiet >= this.timing.typingQuietMs || waited >= this.timing.typingMaxWaitMs) return;
      await this.timing.sleep(
        Math.max(
          1,
          Math.min(this.timing.typingQuietMs - quiet, this.timing.typingMaxWaitMs - waited),
        ),
      );
    }
  }

  private async applyEdit(payload: unknown): Promise<ConnectorApplyEditReply> {
    const request = validateConnectorApplyEditRequest(payload);
    const { id, model } = await this.documentModel(request.path);
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.applyNow(id, model, request));
    this.queues.set(id, run);
    try {
      return await run;
    } finally {
      if (this.queues.get(id) === run) this.queues.delete(id);
    }
  }

  private async applyNow(
    id: string,
    model: AppEditModel,
    request: ReturnType<typeof validateConnectorApplyEditRequest>,
  ): Promise<ConnectorApplyEditReply> {
    await this.typingPause(id);
    if (model.isDisposed()) throw new BridgeError('internal', 'The tab was closed.');
    const conflict = (
      reason: ConnectorEditConflictReason,
      details: { edit?: number; count?: number; nearest?: ConnectorNearestLine[] } = {},
    ): ConnectorApplyEditReply => ({
      status: 'conflict',
      reason,
      edit: details.edit ?? 0,
      ...(details.count === undefined ? {} : { count: details.count }),
      nearest: details.nearest ?? [],
      version: this.host.languageVersion(id),
    });
    if (
      request.baseVersion !== undefined &&
      this.host.languageVersion(id) !== request.baseVersion
    ) {
      return conflict('moved');
    }
    if (request.baseDiskHash !== undefined) {
      const document = this.host.documents().find((entry) => entry.id === id);
      if (
        !document ||
        document.dirty ||
        !(document.diskHash ?? '').startsWith(request.baseDiskHash)
      ) {
        return conflict('moved');
      }
    }
    const text = model.getValue();
    const eol = model.getEOL();
    let replacements: AppReplacement[];
    if (request.content !== undefined) {
      if (text.length > 0) return conflict('moved');
      replacements = [
        { start: 0, end: 0, text: normalizeLineEndings(request.content, eol), edit: 0 },
      ];
    } else {
      const resolution = resolveAppEdits(text, eol, request.edits ?? []);
      if (!resolution.ok) {
        return conflict(resolution.reason, {
          edit: resolution.edit,
          ...(resolution.count === undefined ? {} : { count: resolution.count }),
          nearest: resolution.nearest,
        });
      }
      replacements = resolution.replacements;
    }
    const change = applyReplacements(text, replacements);
    if (utf8Length(change.text) > connectorWorkspaceLimits.resultBytes) {
      throw new BridgeError('too_large', 'The edited file would be larger than 1 MiB.');
    }
    const before = model.getAlternativeVersionId();
    const operations = replacements.map((replacement) => {
      const start = model.getPositionAt(replacement.start);
      const end = model.getPositionAt(replacement.end);
      return {
        range: {
          startLineNumber: start.lineNumber,
          startColumn: start.column,
          endLineNumber: end.lineNumber,
          endColumn: end.column,
        },
        text: replacement.text,
      };
    });
    this.applying = id;
    try {
      model.pushStackElement();
      model.pushEditOperations(null, operations, () => null);
      model.pushStackElement();
    } finally {
      this.applying = null;
    }
    this.mark(id, before, request.appName, request.reason);
    this.highlight(model, change.ranges);
    try {
      await this.host.waitForSync(id);
    } catch {}
    return {
      status: 'applied',
      version: this.host.languageVersion(id),
      startLine: change.startLine,
      endLine: change.endLine,
      lineDelta: change.lineDelta,
    };
  }

  private mark(id: string, before: number, app: string, reason: string | undefined): void {
    const state = this.states.get(id);
    if (state && !state.hidden) {
      state.app = app;
      if (reason) state.reason = reason;
      else delete state.reason;
    } else {
      this.states.set(id, { app, ...(reason ? { reason } : {}), baseline: before, hidden: false });
    }
    this.publish();
  }

  private highlight(
    model: AppEditModel,
    ranges: readonly { startLine: number; endLine: number }[],
  ): void {
    const decorations = model.deltaDecorations(
      [],
      ranges.map((range) => ({
        range: {
          startLineNumber: range.startLine,
          startColumn: 1,
          endLineNumber: range.endLine,
          endColumn: 1,
        },
        options: { isWholeLine: true, className: appEditLineClass, description: 'app-edit' },
      })),
    );
    this.timing.setTimer(() => {
      if (!model.isDisposed()) model.deltaDecorations(decorations, []);
    }, this.timing.highlightMs);
  }

  private publish(): void {
    const next = new Map<string, AppEditMark>();
    for (const [id, state] of this.states) {
      if (!state.hidden)
        next.set(id, { app: state.app, ...(state.reason ? { reason: state.reason } : {}) });
    }
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
