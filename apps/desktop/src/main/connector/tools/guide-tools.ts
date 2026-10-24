import {
  mapTestApiEntries,
  mapTestApiEntry,
  type MapTestApiEntry,
} from '../../../shared/map-test-api-reference';
import {
  ConnectorToolError,
  type ConnectorToolHandler,
  type ConnectorToolRegistry,
  type ConnectorToolResult,
} from '../dispatcher';

export type ReferenceKind = 'command' | 'attribute' | 'constant' | 'xs';
export type LookupKind = ReferenceKind | 'test-api';

export type ReferenceLookupAnswer =
  | { found: true; kind: ReferenceKind; name: string; text: string }
  | { found: false; close: { name: string; kind: ReferenceKind }[] };

export interface GuideToolDependencies {
  lookupReference(params: { name: string; kind?: ReferenceKind }): Promise<unknown>;
}

const referenceKinds: readonly ReferenceKind[] = ['command', 'attribute', 'constant', 'xs'];
const maximumAnswerText = 64 * 1024;
const maximumNameChars = 64;
const closeNameCount = 5;

function isReferenceKind(value: unknown): value is ReferenceKind {
  return typeof value === 'string' && (referenceKinds as readonly string[]).includes(value);
}

function isBoundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

export function parseReferenceLookupAnswer(value: unknown): ReferenceLookupAnswer {
  const invalid = () => new Error('rms-ls returned an invalid reference lookup');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const answer = value as Record<string, unknown>;
  if (answer.found === true) {
    if (
      !isReferenceKind(answer.kind) ||
      !isBoundedText(answer.name, maximumNameChars) ||
      !isBoundedText(answer.text, maximumAnswerText)
    ) {
      throw invalid();
    }
    return { found: true, kind: answer.kind, name: answer.name, text: answer.text };
  }
  if (answer.found !== false || !Array.isArray(answer.close) || answer.close.length > 16) {
    throw invalid();
  }
  const close = answer.close.map((entry: unknown) => {
    const item = entry as Record<string, unknown> | null;
    if (!item || !isBoundedText(item.name, 256) || !isReferenceKind(item.kind)) throw invalid();
    return { name: item.name, kind: item.kind };
  });
  return { found: false, close };
}

export function unescapeMarkdown(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/u)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/\\([!-/:-@[-`{-~])/gu, (_match, mark) => mark),
    )
    .join('');
}

const shortenedNote = '(Shortened to fit; the editor hover shows the rest.)';

export function fitText(text: string, maximum: number): string {
  if ([...text].length <= maximum) return text;
  const room = maximum - shortenedNote.length - 6;
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of text.split('\n\n')) {
    const added = [...paragraph].length + (kept.length > 0 ? 2 : 0);
    if (length + added > room) {
      if (kept.length === 0) {
        let partial = '';
        for (const line of paragraph.split('\n')) {
          const next = partial.length === 0 ? line : `${partial}\n${line}`;
          if ([...next].length > room) break;
          partial = next;
        }
        if (partial.length === 0) partial = [...paragraph].slice(0, room).join('');
        kept.push(partial);
      }
      break;
    }
    kept.push(paragraph);
    length += added;
  }
  let result = kept.join('\n\n');
  if ((result.match(/```/gu)?.length ?? 0) % 2 === 1) result += '\n```';
  return `${result}\n\n${shortenedNote}`;
}

function editDistance(left: string, right: string, limit: number): number | undefined {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 0; row < left.length; row += 1) {
    const current = [row + 1];
    let rowMinimum = row + 1;
    for (let column = 0; column < right.length; column += 1) {
      const value = Math.min(
        previous[column]! + (left[row] === right[column] ? 0 : 1),
        previous[column + 1]! + 1,
        current[column]! + 1,
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > limit) return undefined;
    previous = current;
  }
  const distance = previous[right.length]!;
  return distance <= limit ? distance : undefined;
}

export function closeMapTestNames(name: string): string[] {
  const wanted = name.toLowerCase();
  const limit = Math.max(2, Math.floor(wanted.length / 3));
  const scored: { score: number; difference: number; name: string }[] = [];
  for (const entry of mapTestApiEntries()) {
    let best: { score: number; difference: number } | undefined;
    for (const spelling of new Set([entry.name, entry.name.split('.').at(-1)!])) {
      const lower = spelling.toLowerCase();
      const difference = Math.abs(lower.length - wanted.length);
      let score: number | undefined;
      if (lower === wanted) score = 0;
      else if (wanted.length >= 3 && (lower.includes(wanted) || wanted.includes(lower))) score = 1;
      else if (difference <= limit) {
        const distance = editDistance(wanted, lower, limit);
        if (distance !== undefined) score = 1 + distance;
      }
      if (
        score !== undefined &&
        (!best || score < best.score || (score === best.score && difference < best.difference))
      ) {
        best = { score, difference };
      }
    }
    if (best) scored.push({ ...best, name: entry.name });
  }
  scored.sort(
    (left, right) =>
      left.score - right.score ||
      left.difference - right.difference ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  );
  return scored.slice(0, closeNameCount).map((entry) => entry.name);
}

function mapTestText(entry: MapTestApiEntry): string {
  return `\`\`\`starlark\n${entry.signature}\n\`\`\`\n\n${entry.text}`;
}

const kindWords: Record<LookupKind, string> = {
  command: 'an RMS command',
  attribute: 'an RMS attribute',
  constant: 'an RMS constant or label',
  xs: 'an XS function',
  'test-api': 'a map-test API name',
};

function notFoundText(
  name: string,
  kind: LookupKind | undefined,
  close: readonly { name: string; kind: LookupKind }[],
): string {
  const what = kind === undefined ? '' : ` as ${kindWords[kind]}`;
  const lines = [`No documentation for ${name}${what}.`];
  if (close.length > 0) {
    lines.push(`Close names: ${close.map((entry) => `${entry.name} (${entry.kind})`).join(', ')}.`);
  } else {
    lines.push(
      kind === undefined
        ? 'No close names. Check the spelling; names are case-sensitive.'
        : 'No close names. Check the spelling, or look it up without kind.',
    );
  }
  return lines.join('\n');
}

function unavailableError(): ConnectorToolError {
  return new ConnectorToolError(
    'internal',
    'The documentation lookup is unavailable because the language server of AoE2RMSIDE is not running.',
    { hint: 'Try again in a moment; if it keeps failing, ask the user to look at the Output.' },
  );
}

export function lookupReferenceHandler(dependencies: GuideToolDependencies): ConnectorToolHandler {
  return async (args, context): Promise<ConnectorToolResult> => {
    const name = String(args.name);
    const kind = args.kind === undefined ? undefined : (String(args.kind) as LookupKind);
    const maximum = context.tool.output.maxChars;
    const answer = (text: string): ConnectorToolResult => ({
      content: [{ type: 'text', text: fitText(text, maximum) }],
      facts: { name },
    });
    const mapTestEntry =
      kind === undefined || kind === 'test-api' ? mapTestApiEntry(name) : undefined;
    if (kind === 'test-api') {
      if (mapTestEntry) return answer(mapTestText(mapTestEntry));
      const close = closeMapTestNames(name).map((entry) => ({
        name: entry,
        kind: 'test-api' as const,
      }));
      return answer(notFoundText(name, kind, close));
    }
    let reference: ReferenceLookupAnswer | undefined;
    try {
      reference = parseReferenceLookupAnswer(
        await dependencies.lookupReference(kind === undefined ? { name } : { name, kind }),
      );
    } catch (error) {
      if (context.signal.aborted) throw error;
      if (!mapTestEntry) throw unavailableError();
    }
    if (reference?.found) return answer(unescapeMarkdown(reference.text));
    if (mapTestEntry) return answer(mapTestText(mapTestEntry));
    const close: { name: string; kind: LookupKind }[] = [...(reference?.close ?? [])];
    if (kind === undefined) {
      for (const entry of closeMapTestNames(name)) {
        if (!close.some((known) => known.name === entry))
          close.push({ name: entry, kind: 'test-api' });
      }
    }
    return answer(notFoundText(name, kind, close.slice(0, closeNameCount)));
  };
}

export function registerGuideTools(
  registry: ConnectorToolRegistry,
  dependencies: GuideToolDependencies,
): () => void {
  return registry.register('lookup_reference', lookupReferenceHandler(dependencies));
}
