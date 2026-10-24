export const connectorWorkspaceLimits = Object.freeze({
  path: 32_768,
  appName: 128,
  reason: 120,
  edits: 20,
  oldText: 20_000,
  newText: 100_000,
  content: 524_288,
  occurrences: 200,
  nearestLines: 3,
  lineText: 120,
  documents: 512,
  resultBytes: 1024 * 1024,
});

export interface AppTextEdit {
  oldText: string;
  newText: string;
  all: boolean;
}

export interface ConnectorApplyEditRequest {
  appName: string;
  path: string;
  edits?: AppTextEdit[];
  content?: string;
  baseVersion?: number;
  baseDiskHash?: string;
  reason?: string;
}

export type ConnectorEditConflictReason =
  'not-found' | 'ambiguous' | 'overlap' | 'moved' | 'too-many';

export interface ConnectorNearestLine {
  line: number;
  text: string;
}

export type ConnectorApplyEditReply =
  | {
      status: 'applied';
      version: number | null;
      startLine: number;
      endLine: number;
      lineDelta: number;
    }
  | {
      status: 'conflict';
      reason: ConnectorEditConflictReason;
      edit: number;
      count?: number;
      nearest: ConnectorNearestLine[];
      version: number | null;
    };

export interface ConnectorPathRequest {
  path: string;
}

export interface ConnectorOpenBackgroundReply {
  opened: boolean;
}

export type ConnectorSaveStatus = 'saved' | 'clean' | 'not-open' | 'failed';

export interface ConnectorSaveReply {
  status: ConnectorSaveStatus;
}

export interface ConnectorEditorDocumentState {
  path: string;
  dirty: boolean;
  appEdits: boolean;
  readOnly: boolean;
}

export interface ConnectorEditorStateReply {
  active: string | null;
  documents: ConnectorEditorDocumentState[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error(`${label} has the unknown field ${key}`);
  }
}

function string(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} is not text of ${minimum} to ${maximum} characters`);
  }
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} is not a boolean`);
  return value;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} is not an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function optionalVersion(value: unknown, label: string): number | null {
  return value === null ? null : integer(value, 0, Number.MAX_SAFE_INTEGER, label);
}

const limits = connectorWorkspaceLimits;

function absolutePath(value: unknown, label: string): string {
  const path = string(value, 3, limits.path, label);
  if (!/^[A-Za-z]:[\\/]/u.test(path) || /[\u0000-\u001f]/u.test(path)) {
    throw new Error(`${label} is not an absolute local path`);
  }
  return path;
}

export function validateConnectorApplyEditRequest(value: unknown): ConnectorApplyEditRequest {
  const request = record(value, 'apply edit');
  knownKeys(
    request,
    ['appName', 'path', 'edits', 'content', 'baseVersion', 'baseDiskHash', 'reason'],
    'apply edit',
  );
  if ((request.edits === undefined) === (request.content === undefined)) {
    throw new Error('apply edit needs either edits or content');
  }
  const result: ConnectorApplyEditRequest = {
    appName: string(request.appName, 1, limits.appName, 'apply edit app'),
    path: absolutePath(request.path, 'apply edit path'),
  };
  if (request.edits !== undefined) {
    if (
      !Array.isArray(request.edits) ||
      request.edits.length < 1 ||
      request.edits.length > limits.edits
    ) {
      throw new Error(`apply edit edits is not a list of 1 to ${limits.edits}`);
    }
    result.edits = request.edits.map((entry, index) => {
      const edit = record(entry, `edit ${index}`);
      knownKeys(edit, ['oldText', 'newText', 'all'], `edit ${index}`);
      return {
        oldText: string(edit.oldText, 1, limits.oldText, `edit ${index} oldText`),
        newText: string(edit.newText, 0, limits.newText, `edit ${index} newText`),
        all: bool(edit.all, `edit ${index} all`),
      };
    });
  }
  if (request.content !== undefined) {
    result.content = string(request.content, 0, limits.content, 'apply edit content');
  }
  if (request.baseVersion !== undefined) {
    result.baseVersion = integer(request.baseVersion, 0, Number.MAX_SAFE_INTEGER, 'base version');
  }
  if (request.baseDiskHash !== undefined) {
    if (
      typeof request.baseDiskHash !== 'string' ||
      !/^[0-9a-f]{8,64}$/u.test(request.baseDiskHash)
    ) {
      throw new Error('base disk hash is not a hex prefix');
    }
    result.baseDiskHash = request.baseDiskHash;
  }
  if (request.reason !== undefined) {
    result.reason = string(request.reason, 1, limits.reason, 'apply edit reason');
  }
  return result;
}

const conflictReasons: readonly ConnectorEditConflictReason[] = [
  'not-found',
  'ambiguous',
  'overlap',
  'moved',
  'too-many',
];

export function validateConnectorApplyEditReply(value: unknown): ConnectorApplyEditReply {
  const reply = record(value, 'apply edit reply');
  if (reply.status === 'applied') {
    knownKeys(reply, ['status', 'version', 'startLine', 'endLine', 'lineDelta'], 'apply reply');
    const startLine = integer(reply.startLine, 1, 1_048_576 * 8, 'apply reply startLine');
    return {
      status: 'applied',
      version: optionalVersion(reply.version, 'apply reply version'),
      startLine,
      endLine: integer(reply.endLine, startLine, 1_048_576 * 8, 'apply reply endLine'),
      lineDelta: integer(reply.lineDelta, -1_048_576 * 8, 1_048_576 * 8, 'apply reply lineDelta'),
    };
  }
  if (reply.status !== 'conflict') throw new Error('apply edit reply status is unknown');
  knownKeys(reply, ['status', 'reason', 'edit', 'count', 'nearest', 'version'], 'apply reply');
  if (typeof reply.reason !== 'string' || !conflictReasons.includes(reply.reason as never)) {
    throw new Error('apply edit reply reason is unknown');
  }
  if (!Array.isArray(reply.nearest) || reply.nearest.length > limits.nearestLines) {
    throw new Error('apply edit reply nearest is not a short list');
  }
  return {
    status: 'conflict',
    reason: reply.reason as ConnectorEditConflictReason,
    edit: integer(reply.edit, 0, limits.edits - 1, 'apply reply edit'),
    ...(reply.count === undefined
      ? {}
      : { count: integer(reply.count, 0, 1_000_000, 'apply reply count') }),
    nearest: reply.nearest.map((entry, index) => {
      const line = record(entry, `nearest ${index}`);
      knownKeys(line, ['line', 'text'], `nearest ${index}`);
      return {
        line: integer(line.line, 1, 1_048_576 * 8, `nearest ${index} line`),
        text: string(line.text, 0, limits.lineText, `nearest ${index} text`),
      };
    }),
    version: optionalVersion(reply.version, 'apply reply version'),
  };
}

export function validateConnectorPathRequest(value: unknown): ConnectorPathRequest {
  const request = record(value, 'path request');
  knownKeys(request, ['path'], 'path request');
  return { path: absolutePath(request.path, 'request path') };
}

export function validateConnectorOpenBackgroundReply(value: unknown): ConnectorOpenBackgroundReply {
  const reply = record(value, 'open reply');
  knownKeys(reply, ['opened'], 'open reply');
  return { opened: bool(reply.opened, 'open reply opened') };
}

const saveStatuses: readonly ConnectorSaveStatus[] = ['saved', 'clean', 'not-open', 'failed'];

export function validateConnectorSaveReply(value: unknown): ConnectorSaveReply {
  const reply = record(value, 'save reply');
  knownKeys(reply, ['status'], 'save reply');
  if (typeof reply.status !== 'string' || !saveStatuses.includes(reply.status as never)) {
    throw new Error('save reply status is unknown');
  }
  return { status: reply.status as ConnectorSaveStatus };
}

export function validateConnectorEditorStateRequest(value: unknown): Record<string, never> {
  knownKeys(record(value, 'editor state request'), [], 'editor state request');
  return {};
}

export function validateConnectorEditorStateReply(value: unknown): ConnectorEditorStateReply {
  const reply = record(value, 'editor state');
  knownKeys(reply, ['active', 'documents'], 'editor state');
  if (!Array.isArray(reply.documents) || reply.documents.length > limits.documents) {
    throw new Error(`editor state documents is not a list of at most ${limits.documents}`);
  }
  return {
    active: reply.active === null ? null : absolutePath(reply.active, 'editor state active'),
    documents: reply.documents.map((entry, index) => {
      const document = record(entry, `document ${index}`);
      knownKeys(document, ['path', 'dirty', 'appEdits', 'readOnly'], `document ${index}`);
      return {
        path: absolutePath(document.path, `document ${index} path`),
        dirty: bool(document.dirty, `document ${index} dirty`),
        appEdits: bool(document.appEdits, `document ${index} appEdits`),
        readOnly: bool(document.readOnly, `document ${index} readOnly`),
      };
    }),
  };
}
