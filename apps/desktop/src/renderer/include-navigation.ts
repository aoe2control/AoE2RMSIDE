import { t } from '../shared/i18n/translator';

export const openIncludedFileCommandId = 'rmside.openIncludedFile';

export const cursorOnIncludeContextKey = 'rmsideCursorOnInclude';

export const maximumIncludeTargetLength = 4096;

export interface IncludeLinkPosition {
  line: number;
  character: number;
}

export interface IncludeLinkRange {
  start: IncludeLinkPosition;
  end: IncludeLinkPosition;
}

export interface IncludeLink {
  range: IncludeLinkRange;
  path: string;
  name: string;
  target: string | null;
  readOnly: boolean;
  unresolved: string | null;
}

export interface IncludeHoverPart {
  value: string;
  isTrusted?: { enabledCommands: string[] };
}

function isPosition(value: unknown): value is IncludeLinkPosition {
  const position = value as Partial<IncludeLinkPosition> | null;
  return (
    typeof position === 'object' &&
    position !== null &&
    Number.isSafeInteger(position.line) &&
    Number.isSafeInteger(position.character) &&
    position.line! >= 0 &&
    position.character! >= 0
  );
}

function isRange(value: unknown): value is IncludeLinkRange {
  const range = value as Partial<IncludeLinkRange> | null;
  return (
    typeof range === 'object' && range !== null && isPosition(range.start) && isPosition(range.end)
  );
}

export function validIncludeTarget(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= maximumIncludeTargetLength &&
    /^file:\/\//iu.test(value) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function includeData(value: unknown): Omit<IncludeLink, 'range'> | null {
  const data = value as Record<string, unknown> | null;
  if (typeof data !== 'object' || data === null) return null;
  const { path, name, target, readOnly, unresolved } = data;
  if (typeof path !== 'string' || typeof name !== 'string') return null;
  if (target !== null && target !== undefined && !validIncludeTarget(target)) return null;
  const resolvedTarget = validIncludeTarget(target) ? target : null;
  const reason = typeof unresolved === 'string' && unresolved.length > 0 ? unresolved : null;
  if (resolvedTarget === null && reason === null) return null;
  return {
    path,
    name,
    target: resolvedTarget,
    readOnly: resolvedTarget !== null && readOnly === true,
    unresolved: resolvedTarget === null ? reason : null,
  };
}

export function includeLinksFromLsp(result: unknown): IncludeLink[] {
  if (!Array.isArray(result)) return [];
  return result.flatMap((entry: unknown) => {
    const link = entry as { range?: unknown; data?: unknown } | null;
    if (typeof link !== 'object' || link === null || !isRange(link.range)) return [];
    const data = includeData(link.data);
    return data ? [{ range: link.range, ...data }] : [];
  });
}

export function includeFromHover(result: unknown): Omit<IncludeLink, 'range'> | null {
  const hover = result as { rmsInclude?: unknown } | null;
  return typeof hover === 'object' && hover !== null ? includeData(hover.rmsInclude) : null;
}

function comparePositions(left: IncludeLinkPosition, right: IncludeLinkPosition): number {
  return left.line - right.line || left.character - right.character;
}

export function includeLinkAt(
  links: readonly IncludeLink[],
  position: IncludeLinkPosition,
): IncludeLink | null {
  return (
    links.find(
      (link) =>
        comparePositions(link.range.start, position) <= 0 &&
        comparePositions(position, link.range.end) <= 0,
    ) ?? null
  );
}

export function openIncludedFileCommandUri(target: string): string {
  return `command:${openIncludedFileCommandId}?${encodeURIComponent(JSON.stringify([target]))}`;
}

export function includeTargetFromCommandArguments(args: readonly unknown[]): string | null {
  return args.length === 1 && validIncludeTarget(args[0]) ? args[0] : null;
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/[\\\x60*_{}[\]()#+\-.!<>|~]/gu, '\\$&');
}

export function includeHoverParts(
  include: Pick<IncludeLink, 'name' | 'target'>,
  serverParts: readonly string[],
): IncludeHoverPart[] {
  const description = serverParts.filter((value) => value.length > 0).map((value) => ({ value }));
  if (!include.target) return description;
  const label = escapeMarkdownText(t('code-editor.include.open', { name: include.name }));
  return [
    {
      value: `[${label}](${openIncludedFileCommandUri(include.target)})`,
      isTrusted: { enabledCommands: [openIncludedFileCommandId] },
    },
    ...description,
  ];
}

export function joinConcurrentOpens<Rest extends unknown[]>(
  open: (uri: string, ...rest: Rest) => Promise<boolean>,
  key: (uri: string) => string = (uri) => uri,
): (uri: string, ...rest: Rest) => Promise<boolean> {
  const pending = new Map<string, Promise<boolean>>();
  return (uri, ...rest) => {
    const identity = key(uri);
    const current = pending.get(identity);
    if (current) return current;
    const started = open(uri, ...rest).finally(() => {
      if (pending.get(identity) === started) pending.delete(identity);
    });
    pending.set(identity, started);
    return started;
  };
}
