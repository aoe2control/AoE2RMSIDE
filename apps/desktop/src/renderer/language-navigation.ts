export interface LspPosition {
  line: number;
  character: number;
}

export interface LspNavigationRange {
  start: LspPosition;
  end: LspPosition;
}

export interface DocumentHighlight {
  range: LspNavigationRange;
  kind: 'text' | 'read' | 'write';
}

export interface NavigationLocation {
  uri: string;
  range: LspNavigationRange;
}

function isPosition(value: unknown): value is LspPosition {
  const position = value as Partial<LspPosition> | null;
  return (
    typeof position === 'object' &&
    position !== null &&
    Number.isSafeInteger(position.line) &&
    Number.isSafeInteger(position.character) &&
    position.line! >= 0 &&
    position.character! >= 0
  );
}

function isRange(value: unknown): value is LspNavigationRange {
  const range = value as Partial<LspNavigationRange> | null;
  return (
    typeof range === 'object' && range !== null && isPosition(range.start) && isPosition(range.end)
  );
}

export function documentHighlightsFromLsp(result: unknown): DocumentHighlight[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((value: unknown) => {
    const highlight = value as { range?: unknown; kind?: unknown } | null;
    if (!isRange(highlight?.range)) return [];
    const kind = highlight.kind === 3 ? 'write' : highlight.kind === 2 ? 'read' : 'text';
    return [{ range: highlight.range, kind }];
  });
}

export function definitionLocationsFromLsp(result: unknown): NavigationLocation[] {
  const values = Array.isArray(result) ? (result as unknown[]) : result ? [result] : [];
  return values.flatMap((value) => {
    const location = value as { uri?: unknown; range?: unknown } | null;
    return typeof location?.uri === 'string' && location.uri.length > 0 && isRange(location.range)
      ? [{ uri: location.uri, range: location.range }]
      : [];
  });
}
