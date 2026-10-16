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
    const index = next.findIndex((entry) => sameOpenFile(entry, document));
    if (index < 0) next.push(document);
    else if (!next[index]?.dirty) next[index] = document;
  }
  return next;
}

function sameOpenFile(
  left: Pick<EditorDocument, 'id' | 'path'>,
  right: Pick<EditorDocument, 'id' | 'path'>,
): boolean {
  return (
    left.id === right.id ||
    (left.path !== null && right.path !== null && pathKey(left.path) === pathKey(right.path))
  );
}

export function placeOpenedDocument(
  current: readonly EditorDocument[],
  incoming: EditorDocument,
): { existing: EditorDocument } | { documents: EditorDocument[] } {
  const existing = current.find((document) => sameOpenFile(document, incoming));
  if (existing) return { existing };
  const next = [...current];
  const previewIndex = next.findIndex(isCleanPreview);
  if (previewIndex >= 0) next.splice(previewIndex, 1, incoming);
  else next.push(incoming);
  return { documents: next };
}

export interface WorkspaceFileOpenHost {
  documents(): readonly EditorDocument[];
  setDocuments(next: EditorDocument[]): void;
  activate(id: string, path: string | null): void;
  read(path: string): Promise<EditorDocument>;
  failed(error: unknown): void;
}

export function createWorkspaceFileOpener(
  host: WorkspaceFileOpenHost,
): (path: string, keepOpen?: boolean) => Promise<EditorDocument | null> {
  const pending = new Map<string, Promise<EditorDocument | null>>();
  const findOpen = (path: string, id?: string) =>
    host
      .documents()
      .find(
        (document) =>
          (id !== undefined && document.id === id) ||
          (document.path !== null && pathKey(document.path) === pathKey(path)),
      );
  const show = (existing: EditorDocument, path: string, keepOpen: boolean): EditorDocument => {
    let shown = existing;
    if (keepOpen && existing.preview) {
      shown = { ...existing, preview: false };
      const pinned = shown;
      host.setDocuments(
        host.documents().map((document) => (document.id === existing.id ? pinned : document)),
      );
    }
    host.activate(shown.id, path);
    return shown;
  };
  const readAndPlace = async (path: string, keepOpen: boolean) => {
    let incoming: EditorDocument;
    try {
      incoming = { ...(await host.read(path)), preview: !keepOpen };
    } catch (error) {
      host.failed(error);
      return null;
    }
    const placed = placeOpenedDocument(host.documents(), incoming);
    if ('existing' in placed) return show(placed.existing, path, keepOpen);
    host.setDocuments(placed.documents);
    host.activate(incoming.id, incoming.path);
    return incoming;
  };
  return async (path, keepOpen = false) => {
    const existing = findOpen(path);
    if (existing) return show(existing, path, keepOpen);
    const key = pathKey(path);
    const reading = pending.get(key);
    if (reading) {
      const opened = await reading;
      const current = opened ? findOpen(path, opened.id) : undefined;
      return current ? show(current, path, keepOpen) : null;
    }
    const read = readAndPlace(path, keepOpen);
    pending.set(key, read);
    try {
      return await read;
    } finally {
      if (pending.get(key) === read) pending.delete(key);
    }
  };
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
