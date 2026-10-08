import type * as monaco from 'monaco-editor';
import { rmsBlockOperandCount } from '../shared/rms-blocks';

export interface RmsLines {
  lineCount: number;
  line(lineNumber: number): string;
}

export interface RmsEnterOptions {
  eol: string;
  indentUnit: string;
  indentConditionals?: boolean;
}

export interface RmsEnterEdit {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  text: string;
  caret: { lineNumber: number; column: number };
  closes: 'block' | 'brace' | 'if' | 'random';
}

export const rmsEnterMaximumLength = 4 * 1024 * 1024;

interface Word {
  text: string;
  start: number;
  end: number;
}

interface LineState {
  depth: number;
  words: Word[];
  inside: boolean;
}

export function scanRmsLine(text: string, depth: number, stop = text.length): LineState {
  const words: Word[] = [];
  const pattern = /"[^"]*"?|'[^']*'?|\S+/gu;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index;
    if (start >= stop) break;
    let token = match[0];
    if (depth > 0 && (token.startsWith('"') || token.startsWith("'"))) {
      token = /^\S+/u.exec(text.slice(start))![0];
      pattern.lastIndex = start + token.length;
    }
    const quoted = token.startsWith('"') || token.startsWith("'");
    const opens = token === '/*';
    const closes = token === '*/';
    if (depth > 0) {
      if (opens) depth += 1;
      if (closes) depth -= 1;
      continue;
    }
    if (quoted) {
      const terminated = token.length > 1 && token.endsWith(token[0]!);
      if (!terminated || start + token.length > stop) return { depth, words, inside: true };
      continue;
    }
    if (opens) {
      depth = 1;
      continue;
    }
    if (closes) continue;
    words.push({ text: token, start, end: start + token.length });
  }
  return { depth, words, inside: depth > 0 };
}

function depthBefore(lines: RmsLines, lineNumber: number): number {
  let depth = 0;
  for (let line = 1; line < lineNumber; line += 1) {
    depth = scanRmsLine(lines.line(line), depth).depth;
  }
  return depth;
}

function staysOpen(
  lines: RmsLines,
  lineNumber: number,
  depth: number,
  opener: string,
  closer: string,
  open = 1,
): boolean {
  for (let line = lineNumber + 1; line <= lines.lineCount; line += 1) {
    const state = scanRmsLine(lines.line(line), depth);
    depth = state.depth;
    for (const word of state.words) {
      if (word.text === opener) open += 1;
      else if (word.text === closer && --open === 0) return false;
    }
  }
  return true;
}

function nextCodeWord(lines: RmsLines, lineNumber: number, depth: number): string | null {
  for (let line = lineNumber + 1; line <= lines.lineCount; line += 1) {
    const state = scanRmsLine(lines.line(line), depth);
    depth = state.depth;
    if (state.words.length > 0) return state.words[0]!.text;
  }
  return null;
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/u.exec(text)![0];
}

export function rmsEnterEdit(
  lines: RmsLines,
  lineNumber: number,
  column: number,
  options: RmsEnterOptions,
): RmsEnterEdit | null {
  const text = lines.line(lineNumber);
  if (text.slice(column - 1).trim() !== '') return null;
  const before = text.slice(0, column - 1);
  const trimmed = before.trimEnd();
  const last = /\S+$/u.exec(trimmed)?.[0];
  const first = /^\s*(\S+)/u.exec(trimmed)?.[1];
  if (!last || !first) return null;
  const candidate =
    last === '{' ||
    first === 'if' ||
    first === 'start_random' ||
    rmsBlockOperandCount(first) !== null;
  if (!candidate) return null;

  const startDepth = depthBefore(lines, lineNumber);
  const state = scanRmsLine(text, startDepth, column - 1);
  if (state.inside || state.words.length === 0) return null;
  const words = state.words.map((word) => word.text);
  const indent = leadingWhitespace(text);
  const { eol, indentUnit } = options;
  const replace = (
    body: string,
    caretLine: number,
    caretColumn: number,
    closes: RmsEnterEdit['closes'],
  ) => ({
    lineNumber,
    startColumn: trimmed.length + 1,
    endColumn: text.length + 1,
    text: body,
    caret: { lineNumber: lineNumber + caretLine, column: caretColumn },
    closes,
  });

  if (words.at(-1) === '{') {
    if (!staysOpen(lines, lineNumber, state.depth, '{', '}')) return null;
    const inner = indent + indentUnit;
    return replace(`${eol}${inner}${eol}${indent}}`, 1, inner.length + 1, 'brace');
  }
  if (words.includes('{') || words.includes('}')) return null;

  const head = words[0]!;
  const operands = rmsBlockOperandCount(head);
  if (operands !== null) {
    if (words.length !== operands + 1) return null;
    if (nextCodeWord(lines, lineNumber, state.depth) === '{') return null;
    const inner = indent + indentUnit;
    return replace(`${eol}${indent}{${eol}${inner}${eol}${indent}}`, 2, inner.length + 1, 'block');
  }
  if (head === 'if' && words.length >= 2) {
    const open =
      words.filter((word) => word === 'if').length -
      words.filter((word) => word === 'endif').length;
    if (open <= 0 || !staysOpen(lines, lineNumber, state.depth, 'if', 'endif', open)) {
      return null;
    }
    const inner = options.indentConditionals === false ? indent : indent + indentUnit;
    return replace(`${eol}${inner}${eol}${indent}endif`, 1, inner.length + 1, 'if');
  }
  if (head === 'start_random' && words.length === 1) {
    if (!staysOpen(lines, lineNumber, state.depth, 'start_random', 'end_random')) {
      return null;
    }
    return replace(`${eol}${indent}${eol}${indent}end_random`, 1, indent.length + 1, 'random');
  }
  return null;
}

export function isDuplicateBrace(lineText: string, indentation: string): boolean {
  return lineText === `${indentation}{` || lineText === `${indentation}{}`;
}

export function indentUnitOf(options: monaco.editor.TextModelResolvedOptions): string {
  return options.insertSpaces ? ' '.repeat(options.indentSize) : '\t';
}

let registrations = 0;

export function registerRmsEnter(
  editor: monaco.editor.IStandaloneCodeEditor,
  api: typeof monaco,
  indentConditionals: () => boolean = () => true,
): monaco.IDisposable {
  const editorKey = editor.createContextKey<boolean>('rmside.rmsEnterEditor', true);
  const focus =
    'rmside.rmsEnterEditor && editorTextFocus && !editorReadonly && editorLangId == rms';
  const when = `${focus} && !suggestWidgetVisible || ${focus} && !suggestionMakesTextEdit`;
  const commandId = `rmside.rmsEnter.${(registrations += 1)}`;
  let pending: { versionId: number; lineNumber: number; indentation: string } | null = null;

  const ordinaryEnter = () => editor.trigger('keyboard', 'type', { text: '\n' });
  const enter = () => {
    if (!editor.hasTextFocus()) {
      const focused = api.editor.getEditors().find((candidate) => candidate.hasTextFocus());
      focused?.trigger('keyboard', 'type', { text: '\n' });
      return;
    }
    const model = editor.getModel();
    const selections = editor.getSelections();
    const selection = selections?.length === 1 ? selections[0]! : null;
    if (
      !model ||
      !selection ||
      !selection.isEmpty() ||
      model.getLanguageId() !== 'rms' ||
      model.getValueLength() > rmsEnterMaximumLength
    ) {
      ordinaryEnter();
      return;
    }
    const lines: RmsLines = {
      lineCount: model.getLineCount(),
      line: (lineNumber) => model.getLineContent(lineNumber),
    };
    const edit = rmsEnterEdit(lines, selection.positionLineNumber, selection.positionColumn, {
      eol: model.getEOL(),
      indentUnit: indentUnitOf(model.getOptions()),
      indentConditionals: indentConditionals(),
    });
    if (!edit) {
      ordinaryEnter();
      return;
    }
    const caret = new api.Selection(
      edit.caret.lineNumber,
      edit.caret.column,
      edit.caret.lineNumber,
      edit.caret.column,
    );
    editor.pushUndoStop();
    editor.executeEdits(
      'rmside.rms-enter',
      [
        {
          range: new api.Range(edit.lineNumber, edit.startColumn, edit.lineNumber, edit.endColumn),
          text: edit.text,
        },
      ],
      [caret],
    );
    editor.pushUndoStop();
    editor.revealPosition(caret.getPosition());
    pending =
      edit.closes === 'block' || edit.closes === 'brace'
        ? {
            versionId: model.getVersionId(),
            lineNumber: edit.caret.lineNumber,
            indentation: model.getLineContent(edit.caret.lineNumber),
          }
        : null;
  };
  const command = api.editor.addCommand({ id: commandId, run: enter });
  const keybinding = api.editor.addKeybindingRule({
    keybinding: api.KeyCode.Enter,
    command: commandId,
    when,
  });

  const content = editor.onDidChangeModelContent((event) => {
    const expected = pending;
    pending = null;
    const model = editor.getModel();
    if (!expected || !model || event.isUndoing || event.isRedoing) return;
    if (event.versionId !== expected.versionId + 1 || event.changes.length !== 1) return;
    const change = event.changes[0]!;
    if (
      change.rangeLength !== 0 ||
      (change.text !== '{' && change.text !== '{}') ||
      change.range.startLineNumber !== expected.lineNumber ||
      change.range.startColumn !== expected.indentation.length + 1
    ) {
      return;
    }
    queueMicrotask(() => {
      if (editor.getModel() !== model || model.getVersionId() !== event.versionId) return;
      const line = model.getLineContent(expected.lineNumber);
      if (!isDuplicateBrace(line, expected.indentation)) return;
      const column = expected.indentation.length + 1;
      editor.executeEdits(
        'rmside.rms-enter',
        [
          {
            range: new api.Range(expected.lineNumber, column, expected.lineNumber, line.length + 1),
            text: '',
          },
        ],
        [new api.Selection(expected.lineNumber, column, expected.lineNumber, column)],
      );
    });
  });
  const modelChange = editor.onDidChangeModel(() => {
    pending = null;
  });
  return {
    dispose: () => {
      content.dispose();
      modelChange.dispose();
      keybinding.dispose();
      command.dispose();
      editorKey.set(false);
    },
  };
}
