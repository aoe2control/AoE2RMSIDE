import type { LocalPresentationName, LocalPresentationNames } from '../shared/api';

export interface RmsInlayHint {
  line: number;
  character: number;
  label: string;
  kind: 'type' | 'parameter';
  paddingLeft: boolean;
  paddingRight: boolean;
}

const maximumContentLabelLength = 40;

interface LspInlayHint {
  position?: { line?: unknown; character?: unknown };
  label?: unknown;
  kind?: unknown;
  paddingLeft?: unknown;
  paddingRight?: unknown;
  data?: { rmsContent?: { kind?: unknown; id?: unknown } };
}

function contentLabel(entry: LocalPresentationName): string | null {
  const text = entry.displayName ?? entry.constant;
  if (!text) return null;
  return text.length > maximumContentLabelLength
    ? `${text.slice(0, maximumContentLabelLength - 1)}…`
    : text;
}

function findById(
  entries: readonly LocalPresentationName[],
  id: number,
): LocalPresentationName | null {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const entry = entries[middle]!;
    if (entry.id === id) return entry;
    if (entry.id < id) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export function rmsInlayHintsFromLsp(
  result: unknown,
  names: LocalPresentationNames | null,
): RmsInlayHint[] {
  if (!Array.isArray(result)) return [];
  const hints: RmsInlayHint[] = [];
  for (const value of result as LspInlayHint[]) {
    const line = value?.position?.line;
    const character = value?.position?.character;
    if (
      typeof line !== 'number' ||
      typeof character !== 'number' ||
      !Number.isInteger(line) ||
      !Number.isInteger(character) ||
      line < 0 ||
      character < 0 ||
      typeof value.label !== 'string'
    ) {
      continue;
    }
    let label = value.label;
    const content = value.data?.rmsContent;
    if (content) {
      const id = content.id;
      if (typeof id !== 'number' || !Number.isInteger(id) || !names) continue;
      const entries =
        content.kind === 'object'
          ? names.objects
          : content.kind === 'terrain'
            ? names.terrains
            : null;
      const entry = entries ? findById(entries, id) : null;
      const name = entry ? contentLabel(entry) : null;
      if (!name) continue;
      label = name;
    }
    hints.push({
      line,
      character,
      label,
      kind: value.kind === 2 ? 'parameter' : 'type',
      paddingLeft: value.paddingLeft === true,
      paddingRight: value.paddingRight === true,
    });
  }
  return hints;
}
