import type { WorkspaceFolder } from '../shared/api';
import { isUntitledDocument } from './untitled-documents';
import type { EditorDocument } from './workspace-controller';

export function isCleanPreview(document: Pick<EditorDocument, 'preview' | 'dirty'>): boolean {
  return document.preview && !document.dirty;
}

export function mergeNormalDocuments(
  current: EditorDocument[],
  incoming: EditorDocument[],
): EditorDocument[] {
  const next =
    incoming.length > 0
      ? current.filter((document) => !(isCleanPreview(document) && isUntitledDocument(document)))
      : [...current];
  for (const document of incoming) {
    const index = next.findIndex((entry) => entry.id === document.id);
    if (index < 0) next.push(document);
    else if (!next[index]?.dirty) next[index] = document;
  }
  return next;
}

export function explorerSelection(
  path: string | null,
  folder: Pick<WorkspaceFolder, 'path'> | null,
): string | null {
  return path && folder && isPathInside(path, folder.path) ? path : null;
}

function isPathInside(targetPath: string, folderPath: string): boolean {
  const target = pathKey(targetPath);
  const root = pathKey(folderPath).replace(/\/$/, '');
  return target === root || target.startsWith(`${root}/`);
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}
