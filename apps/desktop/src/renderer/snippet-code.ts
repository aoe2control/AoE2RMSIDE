import { anySnippetSection, type OwnSnippetSection } from '../shared/own-snippets';
import { sectionHeader } from './snippet-placement';

export const rmsSnippetLanguageId = 'rms-snippet';

export const snippetCodeScheme = 'rmside-snippet';

export function snippetCodeUri(sequence: number): string {
  return `${snippetCodeScheme}://code/snippet-${sequence}`;
}

export function isSnippetCodeUri(uri: string): boolean {
  return uri.toLowerCase().startsWith(`${snippetCodeScheme}:`);
}

export function snippetCodePrefix(section: OwnSnippetSection): string {
  return section === anySnippetSection ? '\n' : `${sectionHeader(section)}\n`;
}

export function hiddenLineCount(prefix: string): number {
  let lines = 0;
  for (const character of prefix) if (character === '\n') lines += 1;
  return lines;
}

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export function visibleLspRange<T extends LspRange>(range: T, hiddenLines: number): T | null {
  if (hiddenLines === 0) return range;
  if (range.start.line < hiddenLines || range.end.line < hiddenLines) return null;
  return {
    ...range,
    start: { ...range.start, line: range.start.line - hiddenLines },
    end: { ...range.end, line: range.end.line - hiddenLines },
  };
}

export function visibleSemanticTokens(
  data: readonly number[],
  hiddenLines: number,
): readonly number[] {
  if (hiddenLines === 0) return data;
  const visible: number[] = [];
  let line = 0;
  let start = 0;
  let previousLine: number | null = null;
  let previousStart = 0;
  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index]!;
    const deltaStart = data[index + 1]!;
    line += deltaLine;
    start = deltaLine === 0 ? start + deltaStart : deltaStart;
    if (line < hiddenLines) continue;
    const shownLine = line - hiddenLines;
    if (previousLine === null) {
      visible.push(shownLine, start);
    } else {
      const sameLine = shownLine === previousLine;
      visible.push(shownLine - previousLine, sameLine ? start - previousStart : start);
    }
    visible.push(data[index + 2]!, data[index + 3]!, data[index + 4]!);
    previousLine = shownLine;
    previousStart = start;
  }
  return visible;
}

export const snippetCodeSelectAllActionId = 'rmside.snippetCode.selectAll';

export const snippetCodeMenuActionIds: ReadonlySet<string> = new Set([
  'editor.action.clipboardCutAction',
  'editor.action.clipboardCopyAction',
  'editor.action.clipboardPasteAction',
  snippetCodeSelectAllActionId,
]);

export const snippetCodeBlockedShortcuts: readonly string[] = [
  'F1',
  'Ctrl+Shift+P',
  'F2',
  'Ctrl+F2',
  'F12',
  'Ctrl+F12',
  'Shift+F12',
  'Alt+F12',
  'Ctrl+Shift+F12',
  'Ctrl+Shift+F10',
  'Ctrl+K F12',
  'Shift+Alt+F12',
  'Shift+Alt+F',
  'Ctrl+K Ctrl+F',
  'Ctrl+.',
  'Ctrl+Shift+R',
  'Shift+Alt+O',
  'Ctrl+G',
  'Ctrl+Shift+O',
  'Ctrl+F',
  'Ctrl+H',
  'F3',
  'Shift+F3',
  'Ctrl+F3',
  'Ctrl+Shift+F3',
  'F8',
  'Shift+F8',
  'Alt+F8',
  'Shift+Alt+F8',
];

export interface ShortcutPress {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

export function parseShortcutPresses(shortcut: string): ShortcutPress[] {
  return shortcut.split(' ').map((part) => {
    const names = part.split('+');
    const key = names.pop();
    if (!key) throw new Error(`shortcut ${shortcut} has no key`);
    const press: ShortcutPress = { ctrl: false, shift: false, alt: false, key };
    for (const name of names) {
      if (name === 'Ctrl') press.ctrl = true;
      else if (name === 'Shift') press.shift = true;
      else if (name === 'Alt') press.alt = true;
      else throw new Error(`shortcut ${shortcut} has an unknown modifier ${name}`);
    }
    return press;
  });
}
