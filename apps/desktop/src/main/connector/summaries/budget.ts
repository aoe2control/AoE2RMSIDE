import { ConnectorToolError, connectorJsonText } from '../dispatcher';
import { codePoints } from '../validator';

export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function whole(value: number): number {
  return Math.round(value);
}

export function shorten(text: string, maximum: number): string {
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, maximum - 1).join('')}…`;
}

export function fitToCap(
  value: Record<string, unknown>,
  cap: number,
  trim: readonly string[],
  keep: readonly string[] = [],
): string {
  const copy: Record<string, unknown> = { ...value };
  for (const key of trim) {
    if (Array.isArray(copy[key])) copy[key] = [...(copy[key] as unknown[])];
  }
  const more: Record<string, unknown> =
    typeof copy.more === 'object' && copy.more !== null ? { ...(copy.more as object) } : {};
  let text = connectorJsonText(copy);
  while (codePoints(text) > cap) {
    const key = trim.find(
      (name) => Array.isArray(copy[name]) && (copy[name] as unknown[]).length > 0,
    );
    if (!key) break;
    const items = copy[key] as unknown[];
    const over = codePoints(text) - cap;
    const average = Math.max(1, Math.floor(codePoints(JSON.stringify(items)) / items.length));
    const remove = Math.max(1, Math.min(items.length, Math.floor(over / average)));
    items.splice(items.length - remove, remove);
    more[key] = ((more[key] as number | undefined) ?? 0) + remove;
    copy.more = { ...more };
    text = connectorJsonText(copy);
  }
  if (codePoints(text) <= cap) return text;
  const minimal: Record<string, unknown> = {};
  for (const key of keep) if (copy[key] !== undefined) minimal[key] = copy[key];
  minimal.more = { ...more, cut: true };
  text = connectorJsonText(minimal);
  if (codePoints(text) <= cap) return text;
  return connectorJsonText({ more: { cut: true } });
}

export function encodeCursor(scope: string, offset: number): string {
  return Buffer.from(JSON.stringify({ s: scope, o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: unknown, scope: string): number {
  if (cursor === undefined) return 0;
  try {
    if (typeof cursor !== 'string') throw new Error('cursor');
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      s?: unknown;
      o?: unknown;
    };
    if (value.s !== scope || !Number.isSafeInteger(value.o) || (value.o as number) < 0) {
      throw new Error('cursor');
    }
    return value.o as number;
  } catch {
    throw new ConnectorToolError(
      'invalid_arguments',
      'The cursor does not belong to this request.',
      {
        hint: 'Repeat the request without cursor, or pass the cursor the previous page returned with the same filters.',
      },
    );
  }
}

export function pageToCap(
  base: Record<string, unknown>,
  items: readonly unknown[],
  options: { cap: number; limit: number; cursor: unknown; scope: string },
): string {
  const offset = decodeCursor(options.cursor, options.scope);
  let count = Math.max(0, Math.min(options.limit, items.length - offset));
  for (;;) {
    const page = items.slice(offset, offset + count);
    const next = offset + count;
    const value: Record<string, unknown> = {
      ...base,
      items: page,
      ...(next < items.length
        ? {
            more: {
              items: items.length - next,
              cursor: encodeCursor(options.scope, next),
            },
          }
        : {}),
    };
    const text = connectorJsonText(value);
    if (codePoints(text) <= options.cap || count <= 1) {
      return codePoints(text) <= options.cap
        ? text
        : fitToCap(value, options.cap, ['items'], ['id', 'part']);
    }
    const over = codePoints(text) - options.cap;
    const average = Math.max(1, Math.floor(codePoints(JSON.stringify(page)) / page.length));
    count = Math.max(1, count - Math.max(1, Math.ceil(over / average)));
  }
}
