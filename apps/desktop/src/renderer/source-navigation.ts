import type { PreviewGenerationResult } from '../shared/api';
import type { SourceSelection } from './app-context';

export interface SourceNavigationWorkspace {
  openWorkspaceSource(sourceId: string, keepOpen?: boolean): Promise<{ content: string } | null>;
}

export async function navigateToPreviewOperation(
  map: Pick<PreviewGenerationResult, 'provenanceOperations' | 'provenanceStatus'>,
  operationIndex: number,
  workspace: SourceNavigationWorkspace,
): Promise<SourceSelection | null> {
  const operation = map.provenanceOperations[operationIndex];
  if (!operation) return null;
  const document = await workspace.openWorkspaceSource(operation.sourceId, true);
  if (!document) return null;
  return {
    uri: operation.sourceId,
    utf16StartOffset: utf16OffsetForUtf8Byte(document.content, operation.byteStart),
    utf16EndOffset: utf16OffsetForUtf8Byte(document.content, operation.byteEnd),
    marker: `${operation.displayName}; ${operation.includeChain.join(' → ')}${map.provenanceStatus === 'approximate' ? '; approximate historical range' : ''}`,
  };
}

export function pendingSelectionReveal<T extends { uri: string }>(
  selection: T | null,
  revealed: T | null,
  activeModelUri: string | null,
  normalizeUri: (uri: string) => string,
): T | null {
  if (!selection || selection === revealed || activeModelUri === null) return null;
  return normalizeUri(activeModelUri) === normalizeUri(selection.uri) ? selection : null;
}

export function utf16OffsetForUtf8Byte(source: string, byteOffset: number): number {
  const encoded = new TextEncoder().encode(source);
  const bounded = Math.min(encoded.byteLength, Math.max(0, byteOffset));
  return new TextDecoder('utf-8', { fatal: false }).decode(encoded.subarray(0, bounded)).length;
}

export function utf8ByteForUtf16Offset(source: string, utf16Offset: number): number {
  const bounded = Math.min(source.length, Math.max(0, Math.trunc(utf16Offset)));
  return new TextEncoder().encode(source.slice(0, bounded)).byteLength;
}
