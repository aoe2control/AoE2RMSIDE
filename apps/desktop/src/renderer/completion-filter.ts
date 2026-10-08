export const completionFilterContract = 1;

export interface CompletionFilter {
  contract: number;
  word: string;
}

export interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value?: string };
  insertText?: string;
  insertTextFormat?: number;
  filterText?: string;
  sortText?: string;
  tags?: number[];
  data?: unknown;
  textEdit?: unknown;
  command?: unknown;
}

export interface LspCompletionList {
  items?: LspCompletionItem[];
  isIncomplete?: boolean;
}

export function completionFilter(
  lineContent: string,
  startColumn: number,
  column: number,
): CompletionFilter {
  const start = Math.max(0, startColumn - 1);
  return {
    contract: completionFilterContract,
    word: lineContent.slice(start, Math.max(start, column - 1)),
  };
}

export function resolvesDocumentation(item: LspCompletionItem): boolean {
  return item.data !== undefined && item.documentation === undefined;
}

export function completionList<T>(
  result: LspCompletionList | null,
  toSuggestion: (item: LspCompletionItem) => T,
): { suggestions: T[]; incomplete: boolean } {
  return {
    suggestions: (result?.items ?? []).map(toSuggestion),
    incomplete: result?.isIncomplete === true,
  };
}

export type WordBasedSuggestions = 'off' | 'matchingDocuments';

export function wordBasedSuggestionsFor(languageId: string): WordBasedSuggestions {
  return languageId === 'rms' || languageId === 'xs' ? 'off' : 'matchingDocuments';
}

export const triggerParameterHintsCommand = 'editor.action.triggerParameterHints';

const functionKind = 3;

export interface XsCallInsertion {
  insertText: string;
  command: { id: string; title: string };
}

export function xsCallInsertion(
  item: Pick<LspCompletionItem, 'label' | 'kind' | 'insertText' | 'insertTextFormat' | 'textEdit'>,
  textAfter: string,
): XsCallInsertion | null {
  if (item.kind !== functionKind || item.insertTextFormat === 2 || item.textEdit !== undefined) {
    return null;
  }
  const name = item.insertText ?? item.label;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || /^\s*\(/u.test(textAfter)) return null;
  return {
    insertText: `${name}($0)`,
    command: { id: triggerParameterHintsCommand, title: '' },
  };
}
