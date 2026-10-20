import { decodePreviewTokens, type SnippetPreviewToken } from './snippet-preview-colors';
import { anySnippetSection, snippetNameKey, type OwnSnippet } from '../shared/own-snippets';

export const insertSnippetActionId = 'rmside.insertSnippet';
export const saveSnippetActionId = 'rmside.saveSnippet';

export interface EditorSnippet {
  id: string;
  label: string;
  prefix: string;
  summary: string;
  sections: string[];
  insertText: string;
  preview: string;
  previewTokens: SnippetPreviewToken[];
  fits: boolean;
  own?: OwnSnippet;
}

export interface SnippetCaret {
  section: string | null;
  statement: boolean;
}

export interface DocumentSection {
  name: string;
  header: number;
  start: number;
  end: number;
}

export interface SnippetContext {
  caret: SnippetCaret;
  sections: DocumentSection[];
  previewTokens: unknown[];
}

const maximumSections = 65_536;
const maximumLine = 2 ** 31 - 1;

function lineNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > maximumLine) {
    throw new Error('rms-ls answered with an invalid section');
  }
  return value;
}

export function parseSnippetContext(value: unknown, previewCount: number): SnippetContext {
  const answer = (value ?? {}) as {
    caret?: unknown;
    documentSections?: unknown;
    previewTokens?: unknown;
  };
  const caret = answer.caret as { section?: unknown; statement?: unknown } | undefined;
  if (
    !caret ||
    typeof caret.statement !== 'boolean' ||
    (caret.section !== null && typeof caret.section !== 'string') ||
    (typeof caret.section === 'string' && caret.section.length > 128)
  ) {
    throw new Error('rms-ls answered with an invalid caret');
  }
  const list = answer.documentSections;
  if (!Array.isArray(list) || list.length > maximumSections) {
    throw new Error('rms-ls answered with an invalid section list');
  }
  const sections = list.map((entry: unknown): DocumentSection => {
    const raw = (entry ?? {}) as Record<string, unknown>;
    if (typeof raw.name !== 'string' || raw.name.length > 128) {
      throw new Error('rms-ls answered with an invalid section');
    }
    const section = {
      name: raw.name,
      header: lineNumber(raw.header),
      start: lineNumber(raw.start),
      end: lineNumber(raw.end),
    };
    if (section.start > section.header || section.end < section.header) {
      throw new Error('rms-ls answered with an invalid section');
    }
    return section;
  });
  const previewTokens = answer.previewTokens;
  if (!Array.isArray(previewTokens) || previewTokens.length !== previewCount) {
    throw new Error('rms-ls answered with invalid snippet preview tokens');
  }
  return {
    caret: { section: caret.section as string | null, statement: caret.statement },
    sections,
    previewTokens,
  };
}

export function escapeSnippetText(text: string): string {
  return text.replace(/[\\$}]/gu, (character) => `\\${character}`);
}

export function hasFinalTabStop(text: string): boolean {
  return /(?:^|[^\\])(?:\\\\)*\$(?:0(?![0-9])|\{0[:}])/u.test(text);
}

export function ownSnippetPreview(body: string): string {
  return body
    .replace(/\n+$/u, '')
    .split('\n')
    .map((line) => line.replace(/^[\t ]+/u, (indent) => indent.replaceAll('\t', '    ')))
    .join('\n');
}

export function ownEditorSnippet(
  own: OwnSnippet,
  caret: SnippetCaret,
  previewTokens: unknown = [],
): EditorSnippet {
  const preview = ownSnippetPreview(own.body);
  let tokens: SnippetPreviewToken[] = [];
  try {
    tokens = decodePreviewTokens(previewTokens, preview);
  } catch {}
  const section = own.section === anySnippetSection ? '*' : own.section;
  return {
    id: `own:${snippetNameKey(own.name)}`,
    label: own.name,
    prefix: own.body.trim().split(/\s+/u)[0] ?? '',
    summary: own.description,
    sections: [section],
    insertText: escapeSnippetText(own.body),
    preview,
    previewTokens: tokens,
    fits: caret.statement && (section === '*' || caret.section === section),
    own,
  };
}

const maximumSnippets = 512;
const maximumField = 16_384;

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length > maximumField) {
    throw new Error('rms-ls answered with an invalid snippet');
  }
  return value;
}

export function parseSnippetList(value: unknown): EditorSnippet[] {
  const list = (value as { snippets?: unknown } | null)?.snippets;
  if (!Array.isArray(list) || list.length > maximumSnippets) {
    throw new Error('rms-ls answered with an invalid snippet list');
  }
  const ids = new Set<string>();
  return list.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('rms-ls answered with an invalid snippet');
    const raw = entry as Record<string, unknown>;
    const sections = raw.sections;
    if (!Array.isArray(sections) || sections.length > 16 || typeof raw.fits !== 'boolean') {
      throw new Error('rms-ls answered with an invalid snippet');
    }
    const preview = boundedString(raw.preview);
    const snippet: EditorSnippet = {
      id: boundedString(raw.id),
      label: boundedString(raw.label),
      prefix: boundedString(raw.prefix),
      summary: boundedString(raw.summary),
      sections: sections.map(boundedString),
      insertText: boundedString(raw.insertText),
      preview,
      previewTokens: decodePreviewTokens(raw.previewTokens, preview),
      fits: raw.fits,
    };
    if (!snippet.id || ids.has(snippet.id))
      throw new Error('rms-ls answered with an invalid snippet');
    ids.add(snippet.id);
    return snippet;
  });
}

export function visibleSnippets(
  snippets: readonly EditorSnippet[],
  query: string,
  showAll: boolean,
): EditorSnippet[] {
  const words = query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return snippets.filter((snippet) => {
    if (!showAll && !snippet.fits) return false;
    if (words.length === 0) return true;
    const text = `${snippet.label}\n${snippet.summary}\n${snippet.prefix}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export function snippetListEmptyState(
  snippets: readonly EditorSnippet[],
  query: string,
  showAll: boolean,
): 'none-here' | 'no-search-match' | null {
  if (visibleSnippets(snippets, query, showAll).length > 0) return null;
  if (!showAll && !snippets.some((snippet) => snippet.fits)) return 'none-here';
  return 'no-search-match';
}

export function snippetListIndexAfterKey(
  key: string,
  index: number,
  count: number,
  page = 8,
): number | null {
  if (count === 0) return null;
  const last = count - 1;
  const current = Math.min(Math.max(index, 0), last);
  switch (key) {
    case 'ArrowDown':
      return Math.min(current + 1, last);
    case 'ArrowUp':
      return Math.max(current - 1, 0);
    case 'PageDown':
      return Math.min(current + page, last);
    case 'PageUp':
      return Math.max(current - page, 0);
    default:
      return null;
  }
}

export function snippetSectionHeaders(snippet: EditorSnippet): string[] {
  return snippet.sections
    .filter((section) => section !== '*')
    .map((section) => `<${section.toUpperCase()}>`);
}

export function insertSnippetAvailable(languageId: string | null, readOnly: boolean): boolean {
  return languageId === 'rms' && !readOnly;
}

const listeners = new Set<() => void>();

export function requestInsertSnippet(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeInsertSnippetRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function saveSnippetAvailable(languageId: string | null, readOnly: boolean): boolean {
  return insertSnippetAvailable(languageId, readOnly);
}

export function snippetTextFromSelection(selected: string, leading: string): string {
  const lines = selected.replace(/\r\n?/gu, '\n').split('\n');
  const startsMidLine = !/^[\t ]*$/u.test(leading);
  if (!startsMidLine) lines[0] = `${leading}${lines[0] ?? ''}`;
  while (lines.length > 1 && !lines[lines.length - 1]!.trim()) lines.pop();
  const indents = lines
    .filter((line, index) => line.trim() && !(startsMidLine && index === 0 && lines.length > 1))
    .map((line) => /^[\t ]*/u.exec(line)![0]);
  let shared = indents[0] ?? '';
  for (const indent of indents) {
    let length = 0;
    while (length < shared.length && length < indent.length && shared[length] === indent[length]) {
      length += 1;
    }
    shared = shared.slice(0, length);
  }
  return lines
    .map((line) => (line.startsWith(shared) ? line.slice(shared.length) : line.trimStart()))
    .map((line) => line.replace(/[\t ]+$/u, ''))
    .join('\n');
}

const saveListeners = new Set<() => void>();

export function requestSaveSnippet(): void {
  for (const listener of [...saveListeners]) listener();
}

export function subscribeSaveSnippetRequests(listener: () => void): () => void {
  saveListeners.add(listener);
  return () => saveListeners.delete(listener);
}
