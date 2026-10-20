import { snippetSections, type SnippetSection } from '../shared/own-snippets';
import { hasFinalTabStop, type DocumentSection, type SnippetCaret } from './insert-snippet';

export type SnippetPlacement =
  | { kind: 'caret' }
  | { kind: 'missing'; section: SnippetSection }
  | { kind: 'elsewhere'; section: SnippetSection };

export type SnippetPlacementMode = 'caret' | 'section-end' | 'create-section';

export function sectionHeader(section: string): string {
  return `<${section.toUpperCase()}>`;
}

function isKnownSection(section: string): section is SnippetSection {
  return (snippetSections as readonly string[]).includes(section);
}

function sectionRank(section: string): number {
  return (snippetSections as readonly string[]).indexOf(section);
}

export function snippetPlacement(
  sections: readonly string[],
  caret: SnippetCaret,
  documentSections: readonly DocumentSection[],
): SnippetPlacement {
  if (sections.length === 0 || sections.includes('*')) return { kind: 'caret' };
  if (caret.section !== null && sections.includes(caret.section)) return { kind: 'caret' };
  const known = sections.filter(isKnownSection);
  const present = known.find((section) => documentSections.some((entry) => entry.name === section));
  if (present) return { kind: 'elsewhere', section: present };
  const missing = known[0];
  return missing ? { kind: 'missing', section: missing } : { kind: 'caret' };
}

export interface SnippetEdit {
  lineNumber: number;
  column: number;
  template: string;
}

const blank = (line: string | undefined) => line !== undefined && line.trim() === '';

function withFinalCaret(snippetText: string): string {
  return hasFinalTabStop(snippetText) ? snippetText : `${snippetText}$0`;
}

export function snippetEdit(
  lines: readonly string[],
  documentSections: readonly DocumentSection[],
  section: SnippetSection,
  mode: Exclude<SnippetPlacementMode, 'caret'>,
  snippetText: string,
): SnippetEdit {
  const lastLine = Math.max(0, lines.length - 1);
  const endOf = (line: number) => {
    const index = Math.min(line, lastLine);
    return { lineNumber: index + 1, column: (lines[index] ?? '').length + 1 };
  };
  const snippet = withFinalCaret(snippetText);
  if (mode === 'section-end') {
    const target = [...documentSections].reverse().find((entry) => entry.name === section);
    if (target) {
      const separator = target.end === target.header ? '\n' : '\n\n';
      return { ...endOf(target.end), template: `${separator}${snippet}` };
    }
  }
  const header = sectionHeader(section);
  const rank = sectionRank(section);
  let before: DocumentSection | undefined;
  for (const entry of documentSections) {
    const entryRank = sectionRank(entry.name);
    if (entryRank < 0 || entryRank >= rank) continue;
    if (!before || entryRank >= sectionRank(before.name)) before = entry;
  }
  if (before) {
    const following = lines[Math.min(before.end, lastLine) + 1];
    const after = following !== undefined && !blank(following) ? '\n' : '';
    return { ...endOf(before.end), template: `\n\n${header}\n${snippet}${after}` };
  }
  const first = documentSections[0];
  if (first) {
    const start = Math.min(first.start, lastLine);
    const above = start > 0 && !blank(lines[start - 1]) ? '\n' : '';
    return { lineNumber: start + 1, column: 1, template: `${above}${header}\n${snippet}\n\n` };
  }
  let last = lastLine;
  while (last >= 0 && blank(lines[last])) last -= 1;
  if (last < 0) return { lineNumber: 1, column: 1, template: `${header}\n${snippet}` };
  return { ...endOf(last), template: `\n\n${header}\n${snippet}` };
}
