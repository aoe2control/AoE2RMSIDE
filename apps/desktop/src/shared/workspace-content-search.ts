import type { WorkspaceContentSearchRequest, WorkspaceUnsavedText } from './api';

export const workspaceContentSearchBounds = Object.freeze({
  maximumQueryLength: 256,
  maximumFileBytes: 4 * 1024 * 1024,
  maximumTotalBytes: 64 * 1024 * 1024,
  maximumFiles: 4096,
  maximumUnsavedDocuments: 256,
  maximumUnsavedLength: 4 * 1024 * 1024,
  maximumUnsavedTotalLength: 32 * 1024 * 1024,
  maximumPathLength: 32_768,
});

export const maximumWorkspaceContentOccurrences = 9999;

export interface WorkspaceContentMatchOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

const wordCharacter = '[A-Za-z0-9_]';

export function workspaceContentPattern(
  query: string,
  options: WorkspaceContentMatchOptions,
): RegExp {
  const escaped = query.replace(/[\\^$.*+?()[\]{}|/]/gu, '\\$&');
  const source = options.wholeWord
    ? `(?<!${wordCharacter})${escaped}(?!${wordCharacter})`
    : escaped;
  return new RegExp(source, options.matchCase ? 'gu' : 'giu');
}

export function countWorkspaceContentOccurrences(text: string, pattern: RegExp): number {
  const limit = maximumWorkspaceContentOccurrences + 1;
  pattern.lastIndex = 0;
  let count = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    count += 1;
    if (count >= limit) break;
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  pattern.lastIndex = 0;
  return count;
}

export function formatWorkspaceContentCount(count: number): string {
  return count > maximumWorkspaceContentOccurrences
    ? `${maximumWorkspaceContentOccurrences}+`
    : String(Math.max(0, Math.trunc(count)));
}

export function validateWorkspaceContentSearchRequest(
  value: unknown,
): WorkspaceContentSearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workspace content search request is invalid');
  }
  const request = value as Record<string, unknown>;
  const { query, matchCase, wholeWord, scopeId, unsavedDocuments } = request;
  if (
    typeof query !== 'string' ||
    query.length < 1 ||
    query.length > workspaceContentSearchBounds.maximumQueryLength
  ) {
    throw new Error('workspace content search query is invalid');
  }
  if (typeof matchCase !== 'boolean' || typeof wholeWord !== 'boolean') {
    throw new Error('workspace content search options are invalid');
  }
  if (
    scopeId !== undefined &&
    (typeof scopeId !== 'string' || scopeId.length < 1 || scopeId.length > 256)
  ) {
    throw new Error('workspace content search scope is invalid');
  }
  if (
    !Array.isArray(unsavedDocuments) ||
    unsavedDocuments.length > workspaceContentSearchBounds.maximumUnsavedDocuments
  ) {
    throw new Error('workspace content search unsaved documents are invalid');
  }
  let totalLength = 0;
  const documents: WorkspaceUnsavedText[] = [];
  for (const document of unsavedDocuments as unknown[]) {
    if (!document || typeof document !== 'object') {
      throw new Error('workspace content search unsaved document is invalid');
    }
    const { path, content } = document as Record<string, unknown>;
    if (
      typeof path !== 'string' ||
      path.length < 1 ||
      path.length > workspaceContentSearchBounds.maximumPathLength
    ) {
      throw new Error('workspace content search unsaved document path is invalid');
    }
    if (content !== null) {
      if (
        typeof content !== 'string' ||
        content.length > workspaceContentSearchBounds.maximumUnsavedLength
      ) {
        throw new Error('workspace content search unsaved document text is invalid');
      }
      totalLength += content.length;
      if (totalLength > workspaceContentSearchBounds.maximumUnsavedTotalLength) {
        throw new Error('workspace content search unsaved text is too large');
      }
    }
    documents.push(Object.freeze({ path, content }));
  }
  return Object.freeze({
    query,
    matchCase,
    wholeWord,
    ...(scopeId === undefined ? {} : { scopeId }),
    unsavedDocuments: Object.freeze(documents) as WorkspaceUnsavedText[],
  });
}

export function workspaceUnsavedTexts(
  documents: ReadonlyArray<{ path: string | null; dirty: boolean; content: string }>,
): WorkspaceUnsavedText[] {
  const unsaved: WorkspaceUnsavedText[] = [];
  let totalLength = 0;
  for (const document of documents) {
    if (!document.dirty || !document.path) continue;
    if (document.path.length > workspaceContentSearchBounds.maximumPathLength) continue;
    if (unsaved.length >= workspaceContentSearchBounds.maximumUnsavedDocuments) break;
    const fits =
      document.content.length <= workspaceContentSearchBounds.maximumUnsavedLength &&
      totalLength + document.content.length <=
        workspaceContentSearchBounds.maximumUnsavedTotalLength;
    if (fits) totalLength += document.content.length;
    unsaved.push({ path: document.path, content: fits ? document.content : null });
  }
  return unsaved;
}
