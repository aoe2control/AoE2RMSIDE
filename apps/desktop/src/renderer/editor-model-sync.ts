export interface EditorModelSyncDocument {
  content: string;
  dirty: boolean;
}

export type EditorModelSyncAction =
  { kind: 'keep' } | { kind: 'settle' } | { kind: 'replace'; content: string };

export function editorModelSyncAction(
  modelValue: string,
  rendered: EditorModelSyncDocument,
  latest: EditorModelSyncDocument | undefined,
  locallyEdited: boolean,
): EditorModelSyncAction {
  const current = latest ?? rendered;
  if (modelValue === current.content) return current.dirty ? { kind: 'keep' } : { kind: 'settle' };
  if (locallyEdited && current.dirty) return { kind: 'keep' };
  return { kind: 'replace', content: current.content };
}

export interface EditorTextAdoptionDocument extends EditorModelSyncDocument {
  savedContent: string;
}

export function editorTextAdoption(
  document: EditorTextAdoptionDocument,
  loaded: string,
  editorText: string,
): { content: string; savedContent: string; dirty: boolean } | null {
  if (loaded === editorText || document.content !== loaded) return null;
  const savedContent = document.savedContent === loaded ? editorText : document.savedContent;
  return { content: editorText, savedContent, dirty: editorText !== savedContent };
}
