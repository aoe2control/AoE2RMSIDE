import { decodePreviewTokens, type SnippetPreviewToken } from './snippet-preview-colors';

export const insertSnippetActionId = 'rmside.insertSnippet';

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
