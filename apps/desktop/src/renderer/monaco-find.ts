import type * as monaco from 'monaco-editor';
import type { EditorFindRequest } from './app-context';

export const findControllerId = 'editor.contrib.findController';

const focusFindInput = 1;

interface FindControllerSeam {
  moveToNextMatch(): boolean;
  start(
    options: {
      forceRevealReplace: boolean;
      seedSearchStringFromSelection: 'none' | 'single' | 'multiple';
      seedSearchStringFromNonEmptySelection: boolean;
      seedSearchStringFromGlobalClipboard: boolean;
      shouldFocus: number;
      shouldAnimate: boolean;
      updateSearchScope: boolean;
      loop: boolean;
    },
    state: {
      searchString: string;
      isRegex: boolean;
      matchCase: boolean;
      wholeWord: boolean;
      searchScope: null;
    },
  ): Promise<void> | void;
}

function isFindController(value: unknown): value is FindControllerSeam {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { start?: unknown }).start === 'function' &&
    typeof (value as { moveToNextMatch?: unknown }).moveToNextMatch === 'function'
  );
}

export type ContentMatchGesture = 'click' | 'second-click' | 'pin';

export interface ContentMatchVisit {
  uri: string;
  find: EditorFindRequest;
  step: 'first' | 'next';
}

export function contentMatchStep(
  previous: ContentMatchVisit | null,
  next: { uri: string; find: EditorFindRequest; activeUriBefore: string },
  gesture: ContentMatchGesture,
): 'first' | 'next' | 'stay' {
  const again =
    previous !== null &&
    previous.uri === next.uri &&
    next.activeUriBefore === next.uri &&
    sameEditorFind(previous.find, next.find);
  if (!again) return 'first';
  if (gesture === 'pin') return 'stay';
  if (gesture === 'second-click' && previous.step === 'first') return 'stay';
  return 'next';
}

function sameEditorFind(left: EditorFindRequest, right: EditorFindRequest): boolean {
  return (
    left.query === right.query &&
    left.matchCase === right.matchCase &&
    left.wholeWord === right.wholeWord
  );
}

export function firstFindMatch(
  model: monaco.editor.ITextModel,
  find: EditorFindRequest,
  wordSeparators: string,
): monaco.IRange | null {
  const match = model.findNextMatch(
    find.query,
    { lineNumber: 1, column: 1 },
    false,
    find.matchCase,
    find.wholeWord ? wordSeparators : null,
    false,
  );
  return match ? match.range : null;
}

export async function openEditorFind(
  editor: monaco.editor.ICodeEditor,
  find: EditorFindRequest,
): Promise<boolean> {
  const controller: unknown = editor.getContribution(findControllerId);
  if (!isFindController(controller)) return false;
  await startFind(controller, find);
  return true;
}

export async function moveEditorFindToNextMatch(
  editor: monaco.editor.ICodeEditor,
  find: EditorFindRequest,
): Promise<boolean> {
  const controller: unknown = editor.getContribution(findControllerId);
  if (!isFindController(controller)) return false;
  await startFind(controller, find);
  return controller.moveToNextMatch();
}

async function startFind(controller: FindControllerSeam, find: EditorFindRequest): Promise<void> {
  await controller.start(
    {
      forceRevealReplace: false,
      seedSearchStringFromSelection: 'none',
      seedSearchStringFromNonEmptySelection: false,
      seedSearchStringFromGlobalClipboard: false,
      shouldFocus: focusFindInput,
      shouldAnimate: true,
      updateSearchScope: false,
      loop: true,
    },
    {
      searchString: find.query,
      isRegex: false,
      matchCase: find.matchCase,
      wholeWord: find.wholeWord,
      searchScope: null,
    },
  );
}
