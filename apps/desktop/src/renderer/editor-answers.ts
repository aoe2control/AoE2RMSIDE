export interface LspRangeValue {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

const hoverlessCharacters = /^[\s{};,]$/u;

export function hoverlessAt(line: string, column: number): boolean {
  const character = line.charAt(column - 1);
  return character === '' || hoverlessCharacters.test(character);
}

export const publishedCodeActionsContract = 1;
export const maximumPublishedCodeActionRanges = 512;

export function lspRangeKey(range: LspRangeValue): string {
  return `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
}

export function isLspRangeValue(value: unknown): value is LspRangeValue {
  const range = value as LspRangeValue | null;
  return (
    typeof range?.start?.line === 'number' &&
    typeof range.start.character === 'number' &&
    typeof range.end?.line === 'number' &&
    typeof range.end.character === 'number'
  );
}

export class PublishedCodeActions<Action = unknown> {
  private readonly documents = new Map<
    string,
    { version: number; actions: Map<string, Action[]> }
  >();

  remember(document: string, version: unknown, published: unknown): void {
    this.documents.delete(document);
    const value = published as { contract?: unknown; ranges?: unknown } | null | undefined;
    if (
      typeof version !== 'number' ||
      value?.contract !== publishedCodeActionsContract ||
      !Array.isArray(value.ranges)
    )
      return;
    const actions = new Map<string, Action[]>();
    for (const entry of value.ranges.slice(0, maximumPublishedCodeActionRanges)) {
      const item = entry as { range?: unknown; actions?: unknown } | null;
      if (!isLspRangeValue(item?.range) || !Array.isArray(item.actions)) continue;
      actions.set(lspRangeKey(item.range), item.actions as Action[]);
    }
    this.documents.set(document, { version, actions });
  }

  lookup(document: string, version: number, range: LspRangeValue): Action[] | null {
    const published = this.documents.get(document);
    if (!published || published.version !== version) return null;
    return published.actions.get(lspRangeKey(range)) ?? null;
  }

  forget(document: string): void {
    this.documents.delete(document);
  }
}
