import { presentMessage, stripTransport } from '../shared/message-catalog';
import { t, type MessageId } from '../shared/i18n/translator';
import { deleteEntryConfirmation } from './delete-confirmation';
import { unsavedChangesConfirmation, type DirtyDocumentsAction } from './unsaved-changes';
import {
  engineSentence,
  outputMessageText,
  outputNote,
  type OutputMessage,
  type OutputText,
} from '../shared/output-message';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import type {
  DesktopSession,
  MonacoViewState,
  RecoveryDocument,
  RecoverySnapshot,
  WorkspaceCreateRequest,
  WorkspaceDirectoryEntry,
  WorkspaceDocument,
  WorkspaceFolder,
  WorkspaceMutationResult,
  WorkspaceOpenResult,
} from '../shared/api';
import { isMapTestScriptName } from '../shared/map-test-contract';
import { editorTextAdoption } from './editor-model-sync';
import { formatSourceDocument } from './monaco-language';
import { explorerSelection, isCleanPreview, mergeNormalDocuments } from './open-documents';
import { sameSourceIdentity } from './source-identity';
import {
  createUntitledMapTestDocument,
  createUntitledRmsDocument,
  createUntitledXsDocument,
  editedDocument,
  isUntitledDocument,
} from './untitled-documents';

const emptyDiskHash = '0'.repeat(64);

export type ConfirmationChoice = 'primary' | 'secondary' | 'cancel';

export interface WorkspaceConfirmation {
  title: string;
  description: string;
  primaryLabel: string;
  secondaryLabel?: string;
  destructive?: boolean;
  primaryVariant?: 'default' | 'destructive' | 'warning';
  initialFocus?: 'default' | 'primary';
  resolve(choice: ConfirmationChoice): void;
}

export interface EditorDocument extends RecoveryDocument {
  editedThisOpenLifetime: boolean;
  preview: boolean;
  savedContent: string;
}

export interface WorkspaceController {
  documents: EditorDocument[];
  activeDocument: EditorDocument;
  activeDocumentId: string;
  folder: WorkspaceFolder | null;
  expandedPaths: string[];
  selectedPath: string | null;
  lastNormalActivePath: string | null;
  lastSave: { documentId: string; sequence: number } | null;
  mutationRevision: number;
  sessionReady: boolean;
  restoredSession: DesktopSession | null;
  recoveryNotice: string | null;
  confirmation: WorkspaceConfirmation | null;
  requestConfirmation(value: Omit<WorkspaceConfirmation, 'resolve'>): Promise<ConfirmationChoice>;
  setActiveDocument(id: string): void;
  setDocumentContent(id: string, content: string): void;
  adoptEditorText(id: string, loaded: string, editorText: string): void;
  latestDocument(id: string): EditorDocument | undefined;
  setDocumentViewState(id: string, viewState: MonacoViewState | null): void;
  promoteDocument(id: string): void;
  reorderDocument(sourceId: string, targetId: string, placement: 'before' | 'after'): void;
  setFolderExpanded(path: string, expanded: boolean): void;
  setSelectedPath(path: string | null): void;
  dismissRecoveryNotice(): void;
  answerConfirmation(choice: ConfirmationChoice): void;
  newFile(): void;
  newMapTestScript(): void;
  newXsScript(): void;
  pickFiles(): Promise<void>;
  pickFolder(): Promise<void>;
  openRecent(path: string): Promise<void>;
  openWorkspaceFile(path: string, keepOpen?: boolean): Promise<void>;
  openWorkspaceSource(sourceId: string, keepOpen?: boolean): Promise<EditorDocument | null>;
  acceptOpenResult(result: WorkspaceOpenResult): void;
  openDroppedFiles(files: File[]): Promise<void>;
  createWorkspaceEntry(request: WorkspaceCreateRequest): Promise<WorkspaceMutationResult>;
  openGeneratedFile(path: string): Promise<void>;
  renameWorkspaceEntry(
    entry: WorkspaceDirectoryEntry,
    name: string,
  ): Promise<WorkspaceMutationResult>;
  deleteWorkspaceEntry(entry: WorkspaceDirectoryEntry): Promise<WorkspaceMutationResult | null>;
  saveActive(): Promise<void>;
  saveActiveAs(): Promise<void>;
  formatActive(): Promise<void>;
  closeActive(): Promise<void>;
  saveDocumentById(id: string): Promise<void>;
  saveDocumentAsById(id: string): Promise<void>;
  closeDocumentById(id: string): Promise<void>;
  closeFolder(): Promise<void>;
}

export function useWorkspaceController(
  appendOutput: (message: OutputMessage) => void,
  formatOnSave: boolean,
  deletePermanently = false,
): WorkspaceController {
  const deletePermanentlyRef = useRef(deletePermanently);
  deletePermanentlyRef.current = deletePermanently;
  const untitledCounter = useRef(2);
  const [documents, setDocuments] = useState<EditorDocument[]>(() => [
    createUntitledRmsDocument(1, 'automatic'),
  ]);
  const [activeDocumentId, setActiveDocumentId] = useState(documents[0]?.id ?? '');
  const [folder, setFolder] = useState<WorkspaceFolder | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [lastNormalActivePath, setLastNormalActivePath] = useState<string | null>(null);
  const [lastSave, setLastSave] = useState<{ documentId: string; sequence: number } | null>(null);
  const [mutationRevision, setMutationRevision] = useState(0);
  const [sessionReady, setSessionReady] = useState(false);
  const [restoredSession, setRestoredSession] = useState<DesktopSession | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<WorkspaceConfirmation | null>(null);
  const documentsRef = useRef(documents);
  const activeDocumentIdRef = useRef(activeDocumentId);
  const folderRef = useRef(folder);
  const saveSequence = useRef(0);
  documentsRef.current = documents;
  activeDocumentIdRef.current = activeDocumentId;
  folderRef.current = folder;
  const recordSave = useCallback((documentId: string) => {
    saveSequence.current += 1;
    setLastSave({ documentId, sequence: saveSequence.current });
  }, []);
  const activeDocument =
    documents.find((document) => document.id === activeDocumentId) ??
    documents[0] ??
    createUntitledRmsDocument(1, 'automatic');

  const latestDocument = useCallback(
    (id: string) => documentsRef.current.find((document) => document.id === id),
    [],
  );

  const activateDocument = useCallback((id: string) => {
    setActiveDocumentId(id);
    const document = documentsRef.current.find((entry) => entry.id === id);
    const currentFolder = folderRef.current;
    setSelectedPath(
      document?.path && currentFolder && isPathInside(document.path, currentFolder.path)
        ? document.path
        : null,
    );
  }, []);

  useEffect(() => {
    if (activeDocument.path && !activeDocument.preview) {
      setLastNormalActivePath(activeDocument.path);
    }
  }, [activeDocument.path, activeDocument.preview]);

  const requestConfirmation = useCallback(
    (value: Omit<WorkspaceConfirmation, 'resolve'>): Promise<ConfirmationChoice> =>
      new Promise((resolve) => setConfirmation({ ...value, resolve })),
    [],
  );

  const replaceDocument = useCallback((oldId: string, next: EditorDocument) => {
    const update = (current: EditorDocument[]) => {
      const existingNext = current.findIndex((document) => document.id === next.id);
      const oldIndex = current.findIndex((document) => document.id === oldId);
      const without = current.filter(
        (document) => document.id !== oldId && document.id !== next.id,
      );
      const insertion = Math.min(
        oldIndex >= 0 ? oldIndex : existingNext >= 0 ? existingNext : without.length,
        without.length,
      );
      without.splice(insertion, 0, next);
      return without;
    };
    const nextDocuments = update(documentsRef.current);
    documentsRef.current = nextDocuments;
    setDocuments(nextDocuments);
    setActiveDocumentId((current) => (current === oldId ? next.id : current));
  }, []);

  const prepareDocumentForSave = useCallback(
    async (document: EditorDocument): Promise<string | null> => {
      if (!formatOnSave || document.readOnly || isMapTestScriptName(document.name)) {
        return document.content;
      }
      const outcome = await formatSourceDocument(document.uri, document.name, document.content);
      if (outcome.status === 'formatted' || outcome.status === 'unchanged') {
        return outcome.content;
      }
      if (outcome.status === 'skipped') {
        appendOutput(
          outputNote(
            'Files',
            'format.save-skipped',
            { id: 'workspace.format.save-skipped', args: { name: document.name } },
            {
              severity: 'warning',
              cause: formattingReason(outcome, 'workspace.format.reason.not-proven'),
              ...formattingDetail(outcome.reason),
            },
          ),
        );
        return document.content;
      }
      appendOutput(
        outputNote(
          'Files',
          'format.save-cancelled',
          { id: 'workspace.format.save-cancelled', args: { name: document.name } },
          {
            severity: 'warning',
            cause: formattingReason(outcome, 'workspace.format.reason.stale'),
            ...formattingDetail(outcome.reason),
          },
        ),
      );
      return null;
    },
    [appendOutput, formatOnSave],
  );

  const formatDocument = useCallback(
    async (document: EditorDocument): Promise<void> => {
      if (document.readOnly) {
        appendOutput(
          outputNote('Files', 'format.read-only', {
            id: 'workspace.format.read-only',
            args: { name: document.name },
          }),
        );
        return;
      }
      const outcome = await formatSourceDocument(document.uri, document.name, document.content);
      if (outcome.status === 'unchanged') {
        appendOutput(
          outputNote('Files', 'format.unchanged', {
            id: 'workspace.format.unchanged',
            args: { name: document.name },
          }),
        );
      } else if (outcome.status !== 'formatted') {
        appendOutput(
          outputNote(
            'Files',
            'format.not-formatted',
            { id: 'workspace.format.not-formatted', args: { name: document.name } },
            {
              severity: 'warning',
              cause: formattingReason(outcome, 'workspace.format.reason.not-proven'),
              ...formattingDetail(outcome.reason),
            },
          ),
        );
      }
    },
    [appendOutput],
  );

  const saveDocumentAs = useCallback(
    async (document: EditorDocument): Promise<string | null> => {
      try {
        const content = await prepareDocumentForSave(document);
        if (content === null) return null;
        const saved = await window.rmside.saveFileAs({
          documentId: document.id,
          content,
          suggestedName: document.name,
          encoding: document.encoding,
          newlineStyle: document.newlineStyle,
        });
        if (!saved) return null;
        replaceDocument(document.id, documentFromWorkspace(saved));
        recordSave(saved.id);
        return saved.id;
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.save',
          }),
        );
        return null;
      }
    },
    [appendOutput, prepareDocumentForSave, recordSave, replaceDocument],
  );

  const saveDocument = useCallback(
    async (document: EditorDocument, overwriteExternalChange = false): Promise<string | null> => {
      if (!document.path || document.readOnly) return saveDocumentAs(document);
      try {
        const content = await prepareDocumentForSave(document);
        if (content === null) return null;
        const result = await window.rmside.saveFile({
          documentId: document.id,
          path: document.path,
          content,
          diskHash: document.diskHash,
          overwriteExternalChange,
        });
        if (result.status === 'saved') {
          const next = documentFromWorkspace(result.document, {
            editedThisOpenLifetime: document.editedThisOpenLifetime,
            preview: false,
            viewState: document.viewState,
          });
          replaceDocument(document.id, next);
          recordSave(next.id);
          return result.document.id;
        }

        const choice = await requestConfirmation({
          title: t('dialog.external-change.title', { name: document.name }),
          description: t('dialog.external-change.save.description'),
          primaryLabel: t('dialog.external-change.replace'),
          secondaryLabel: t('dialog.external-change.reload'),
          destructive: true,
        });
        if (choice === 'primary') {
          const latest = documentsRef.current.find((entry) => entry.id === document.id) ?? document;
          return saveDocument(latest, true);
        }
        if (choice === 'secondary') {
          replaceDocument(document.id, documentFromWorkspace(result.current));
          appendOutput(reloadedNote(document.name));
          return result.current.id;
        }
        return null;
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.save',
          }),
        );
        return null;
      }
    },
    [
      appendOutput,
      prepareDocumentForSave,
      recordSave,
      replaceDocument,
      requestConfirmation,
      saveDocumentAs,
    ],
  );

  const confirmDirtyDocuments = useCallback(
    async (dirtyDocuments: EditorDocument[], action: DirtyDocumentsAction): Promise<boolean> => {
      if (dirtyDocuments.length === 0) return true;
      const choice = await requestConfirmation({
        ...unsavedChangesConfirmation(dirtyDocuments, action),
        initialFocus: 'primary',
      });
      if (choice === 'cancel') return false;
      if (choice === 'secondary') return true;
      for (const document of dirtyDocuments) {
        if (!(await saveDocument(document))) return false;
      }
      return true;
    },
    [requestConfirmation, saveDocument],
  );

  const ensureDocument = useCallback(() => {
    setDocuments((current) => {
      if (current.length > 0) return current;
      const document = createUntitledRmsDocument(untitledCounter.current++, 'automatic');
      documentsRef.current = [document];
      setActiveDocumentId(document.id);
      return [document];
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [restored, recovery] = await Promise.all([
          window.rmside.getDesktopSession(),
          window.rmside.readRecovery(),
        ]);
        if (cancelled) return;
        const sessionDocuments = restored.documents.map((document) => {
          const tab = restored.session.workspace.normalTabs.find(
            (entry) => pathKey(entry.path) === pathKey(document.path),
          );
          return documentFromWorkspace(document, { viewState: tab?.viewState ?? null });
        });
        const recoveredDocuments = (recovery?.documents ?? []).filter((document) => document.dirty);
        const merged = mergeRecovery(sessionDocuments, recoveredDocuments);
        const nextDocuments =
          merged.length > 0 ? merged : [createUntitledRmsDocument(1, 'automatic')];
        const recoveredActive = recovery?.activeDocumentId
          ? nextDocuments.find((entry) => entry.id === recovery.activeDocumentId)?.id
          : undefined;
        const sessionActivePath = restored.session.workspace.activePath;
        const sessionActive = sessionActivePath
          ? nextDocuments.find(
              (entry) => entry.path && pathKey(entry.path) === pathKey(sessionActivePath),
            )?.id
          : undefined;
        documentsRef.current = nextDocuments;
        setDocuments(nextDocuments);
        setActiveDocumentId(recoveredActive ?? sessionActive ?? nextDocuments[0]?.id ?? '');
        setFolder(restored.session.workspace.folder);
        setExpandedPaths(restored.session.workspace.expandedPaths);
        setSelectedPath(restored.session.workspace.selectedPath);
        setRestoredSession(restored.session);
        for (const diagnostic of restored.diagnostics) {
          appendOutput(
            outputNote('Recovery', 'recovery.restore-note', diagnostic, { severity: 'warning' }),
          );
        }
        if (recoveredDocuments.length > 0) {
          const restoredNote = outputNote(
            'Recovery',
            'recovery.restored',
            { id: 'workspace.recovery.restored', args: { count: recoveredDocuments.length } },
            { cause: { id: 'workspace.recovery.restored.cause' } },
          );
          setRecoveryNotice(outputMessageText(restoredNote));
          appendOutput(restoredNote);
        }
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Recovery',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.restore-session',
          }),
        );
      } finally {
        if (!cancelled) setSessionReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [appendOutput]);

  useEffect(() => {
    if (!sessionReady) return undefined;
    const dirtyDocuments = documents.filter((document) => document.dirty);
    const timer = window.setTimeout(() => {
      const operation =
        dirtyDocuments.length === 0
          ? window.rmside.clearRecovery()
          : window.rmside.writeRecovery({
              version: 1,
              activeDocumentId: dirtyDocuments.some((document) => document.id === activeDocumentId)
                ? activeDocumentId
                : (dirtyDocuments[0]?.id ?? null),
              folder,
              documents: dirtyDocuments.map(recoveryDocument),
              savedAt: Date.now(),
            } satisfies RecoverySnapshot);
      void operation.catch((error: unknown) =>
        appendOutput(
          presentMessage({
            source: 'Recovery',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.back-up',
          }),
        ),
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [activeDocumentId, appendOutput, documents, folder, sessionReady]);

  useEffect(
    () =>
      window.rmside.onWindowCloseRequested(() => {
        void (async () => {
          const dirtyDocuments = documentsRef.current.filter((document) => document.dirty);
          const allow = await confirmDirtyDocuments(dirtyDocuments, { kind: 'close-window' });
          if (allow) await window.rmside.clearRecovery();
          await window.rmside.respondToWindowClose(allow);
        })();
      }),
    [confirmDirtyDocuments],
  );

  useEffect(
    () =>
      window.rmside.onWorkspaceExternalChange((change) => {
        const current = documentsRef.current.find((document) =>
          change.kind === 'changed'
            ? document.id === change.document.id
            : document.id === change.documentId,
        );
        if (!current) return;
        if (change.kind === 'deleted') {
          updateDocuments(setDocuments, documentsRef, (documents) =>
            documents.map((document) =>
              document.id === current.id
                ? {
                    ...document,
                    path: null,
                    readOnly: false,
                    sourceKind: 'ordinary' as const,
                    diskHash: emptyDiskHash,
                    dirty: true,
                    preview: false,
                    editedThisOpenLifetime: true,
                  }
                : document,
            ),
          );
          appendOutput(
            outputNote(
              'Files',
              'files.deleted-outside',
              { id: 'workspace.files.deleted-outside', args: { name: current.name } },
              {
                severity: 'warning',
                cause: { id: 'workspace.files.deleted-outside.cause' },
              },
            ),
          );
          return;
        }
        const incoming = documentFromWorkspace(change.document, { viewState: current.viewState });
        if (!current.dirty) {
          replaceDocument(current.id, incoming);
          appendOutput(reloadedNote(current.name));
          return;
        }
        void (async () => {
          const choice = await requestConfirmation({
            title: t('dialog.external-change.title', { name: current.name }),
            description: t('dialog.external-change.dirty.description'),
            primaryLabel: t('dialog.external-change.reload'),
            secondaryLabel: t('dialog.external-change.keep-editing'),
            destructive: true,
          });
          if (choice === 'primary') {
            replaceDocument(current.id, incoming);
            appendOutput(reloadedNote(current.name));
          }
        })();
      }),
    [appendOutput, replaceDocument, requestConfirmation],
  );

  const acceptOpenResult = useCallback((result: WorkspaceOpenResult) => {
    const incoming = result.documents.map((document) => documentFromWorkspace(document));
    const next = mergeNormalDocuments(documentsRef.current, incoming);
    documentsRef.current = next;
    setDocuments(next);
    const lastDocument = incoming.at(-1);
    if (lastDocument) setActiveDocumentId(lastDocument.id);
    if (result.folder) {
      folderRef.current = result.folder;
      setFolder(result.folder);
      setExpandedPaths([]);
      setSelectedPath(result.folder.path);
    } else {
      const revealed = explorerSelection(lastDocument?.path ?? null, folderRef.current);
      if (revealed) setSelectedPath(revealed);
    }
    setMutationRevision((revision) => revision + 1);
  }, []);

  useEffect(() => {
    if (!sessionReady) return undefined;
    let disposed = false;
    let draining = false;
    let again = false;
    const drain = async () => {
      if (draining) {
        again = true;
        return;
      }
      draining = true;
      try {
        do {
          again = false;
          for (;;) {
            const taken = await window.rmside.takeShellOpenRequest();
            if (!taken) break;
            if (taken.opened) acceptOpenResult(taken.opened);
            if (disposed) break;
          }
        } while (again && !disposed);
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.open-requested',
          }),
        );
      } finally {
        draining = false;
      }
    };
    const unsubscribe = window.rmside.onShellOpenPending(() => void drain());
    void drain();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [acceptOpenResult, appendOutput, sessionReady]);

  const newFile = useCallback(() => {
    const document = createUntitledRmsDocument(untitledCounter.current++, 'explicit');
    updateDocuments(setDocuments, documentsRef, (current) =>
      replaceCleanPreviewOrAppend(current, document),
    );
    setActiveDocumentId(document.id);
  }, []);

  const newMapTestScript = useCallback(() => {
    const document = createUntitledMapTestDocument(untitledCounter.current++);
    updateDocuments(setDocuments, documentsRef, (current) =>
      replaceCleanPreviewOrAppend(current, document),
    );
    setActiveDocumentId(document.id);
  }, []);

  const newXsScript = useCallback(() => {
    const document = createUntitledXsDocument(untitledCounter.current++);
    updateDocuments(setDocuments, documentsRef, (current) =>
      replaceCleanPreviewOrAppend(current, document),
    );
    setActiveDocumentId(document.id);
  }, []);

  const pickFiles = useCallback(async () => {
    try {
      const result = await window.rmside.pickFiles();
      if (result) acceptOpenResult(result);
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Files',
          raw: errorMessage(error),
          fallbackHeadline: 'workspace.failed.open-file',
        }),
      );
    }
  }, [acceptOpenResult, appendOutput]);

  const pickFolder = useCallback(async () => {
    try {
      const result = await window.rmside.pickFolder();
      if (result) acceptOpenResult(result);
    } catch (error) {
      appendOutput(
        presentMessage({
          source: 'Files',
          raw: errorMessage(error),
          fallbackHeadline: 'workspace.failed.open-folder',
        }),
      );
    }
  }, [acceptOpenResult, appendOutput]);

  const openRecent = useCallback(
    async (path: string) => {
      try {
        acceptOpenResult(await window.rmside.openRecent(path));
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.open-recent',
          }),
        );
      }
    },
    [acceptOpenResult, appendOutput],
  );

  const openWorkspaceFile = useCallback(
    async (path: string, keepOpen = false) => {
      const existing = documentsRef.current.find(
        (document) => document.path && pathKey(document.path) === pathKey(path),
      );
      if (existing) {
        if (keepOpen && existing.preview) {
          updateDocuments(setDocuments, documentsRef, (current) =>
            current.map((document) =>
              document.id === existing.id ? { ...document, preview: false } : document,
            ),
          );
        }
        setActiveDocumentId(existing.id);
        setSelectedPath(path);
        return;
      }
      try {
        const incoming = documentFromWorkspace(await window.rmside.openWorkspaceFile(path), {
          preview: !keepOpen,
        });
        const current = documentsRef.current;
        const previewIndex = current.findIndex((document) => document.preview && !document.dirty);
        const next = [...current];
        if (previewIndex >= 0) next.splice(previewIndex, 1, incoming);
        else next.push(incoming);
        documentsRef.current = next;
        setDocuments(next);
        setActiveDocumentId(incoming.id);
        setSelectedPath(incoming.path);
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.open-file',
          }),
        );
      }
    },
    [appendOutput],
  );

  const openWorkspaceSource = useCallback(
    async (sourceId: string, keepOpen = false): Promise<EditorDocument | null> => {
      const existing = documentsRef.current.find((document) =>
        sameSourceIdentity(document.uri, sourceId),
      );
      if (existing) {
        if (keepOpen && existing.preview) {
          updateDocuments(setDocuments, documentsRef, (current) =>
            current.map((document) =>
              document.id === existing.id ? { ...document, preview: false } : document,
            ),
          );
        }
        setActiveDocumentId(existing.id);
        setSelectedPath(explorerSelection(existing.path, folderRef.current));
        return existing;
      }
      try {
        const incoming = documentFromWorkspace(await window.rmside.openWorkspaceSource(sourceId), {
          preview: !keepOpen,
        });
        const current = documentsRef.current;
        const alreadyOpen = current.find(
          (document) =>
            document.id === incoming.id ||
            (document.path && incoming.path && pathKey(document.path) === pathKey(incoming.path)),
        );
        if (alreadyOpen) {
          const selected =
            keepOpen && alreadyOpen.preview ? { ...alreadyOpen, preview: false } : alreadyOpen;
          if (selected !== alreadyOpen) {
            updateDocuments(setDocuments, documentsRef, (documents) =>
              documents.map((document) => (document.id === alreadyOpen.id ? selected : document)),
            );
          }
          setActiveDocumentId(alreadyOpen.id);
          setSelectedPath(explorerSelection(alreadyOpen.path, folderRef.current));
          return selected;
        }
        const previewIndex = current.findIndex((document) => document.preview && !document.dirty);
        const next = [...current];
        if (previewIndex >= 0) next.splice(previewIndex, 1, incoming);
        else next.push(incoming);
        documentsRef.current = next;
        setDocuments(next);
        setActiveDocumentId(incoming.id);
        setSelectedPath(explorerSelection(incoming.path, folderRef.current));
        return incoming;
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Preview',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.open-map-item-source',
          }),
        );
        return null;
      }
    },
    [appendOutput],
  );

  const openDroppedFiles = useCallback(
    async (files: File[]) => {
      try {
        acceptOpenResult(await window.rmside.openDroppedFiles(files));
      } catch (error) {
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.open-dropped',
          }),
        );
      }
    },
    [acceptOpenResult, appendOutput],
  );

  const createWorkspaceEntry = useCallback(
    async (request: WorkspaceCreateRequest) => {
      try {
        const result = await window.rmside.createWorkspaceEntry(request);
        setMutationRevision((revision) => revision + 1);
        if (result.entry) setSelectedPath(result.entry.path);
        if (result.kind === 'file') await openWorkspaceFile(result.targetPath, true);
        return result;
      } catch (error) {
        setMutationRevision((revision) => revision + 1);
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.create',
          }),
        );
        throw error;
      }
    },
    [appendOutput, openWorkspaceFile],
  );

  const openGeneratedFile = useCallback(
    async (path: string) => {
      setMutationRevision((revision) => revision + 1);
      await openWorkspaceFile(path);
    },
    [openWorkspaceFile],
  );

  const renameWorkspaceEntry = useCallback(
    async (entry: WorkspaceDirectoryEntry, name: string) => {
      try {
        const result = await window.rmside.renameWorkspaceEntry({ entryId: entry.id, name });
        if (result.pathChanges.length > 0) {
          updateDocuments(setDocuments, documentsRef, (current) =>
            current.map((document) => {
              const change = result.pathChanges.find(
                (candidate) =>
                  candidate.oldId === document.id ||
                  (document.path && pathKey(candidate.oldPath) === pathKey(document.path)),
              );
              return change
                ? {
                    ...document,
                    id: change.newId,
                    uri: change.newUri,
                    path: change.newPath,
                    name: basenameFromPath(change.newPath),
                  }
                : document;
            }),
          );
          setActiveDocumentId(
            (current) =>
              result.pathChanges.find((change) => change.oldId === current)?.newId ?? current,
          );
          setExpandedPaths((current) => remapPaths(current, result));
          setSelectedPath((current) => remapPath(current, result));
        }
        setMutationRevision((revision) => revision + 1);
        return result;
      } catch (error) {
        setMutationRevision((revision) => revision + 1);
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.rename',
          }),
        );
        throw error;
      }
    },
    [appendOutput],
  );

  const deleteWorkspaceEntry = useCallback(
    async (entry: WorkspaceDirectoryEntry) => {
      const permanent = deletePermanentlyRef.current;
      const choice = await requestConfirmation(deleteEntryConfirmation(entry, permanent));
      if (choice !== 'primary') return null;
      const affected = documentsRef.current.filter(
        (document) => document.path && isPathInside(document.path, entry.path),
      );
      if (
        !(await confirmDirtyDocuments(
          affected.filter((document) => document.dirty),
          { kind: 'delete', name: entry.name },
        ))
      ) {
        return null;
      }
      try {
        const result = await window.rmside.deleteWorkspaceEntry({
          entryId: entry.id,
          ...(permanent ? { permanent: true } : {}),
        });
        const affectedIds = new Set(affected.map((document) => document.id));
        updateDocuments(setDocuments, documentsRef, (current) =>
          current.filter((document) => !affectedIds.has(document.id)),
        );
        setActiveDocumentId((current) =>
          affectedIds.has(current)
            ? (documentsRef.current.find((document) => !affectedIds.has(document.id))?.id ?? '')
            : current,
        );
        setExpandedPaths((current) => current.filter((path) => !isPathInside(path, entry.path)));
        setSelectedPath((current) =>
          current && isPathInside(current, entry.path) ? null : current,
        );
        setMutationRevision((revision) => revision + 1);
        window.setTimeout(ensureDocument, 0);
        return result;
      } catch (error) {
        setMutationRevision((revision) => revision + 1);
        appendOutput(
          presentMessage({
            source: 'Files',
            raw: errorMessage(error),
            fallbackHeadline: 'workspace.failed.delete',
          }),
        );
        return null;
      }
    },
    [appendOutput, confirmDirtyDocuments, ensureDocument, requestConfirmation],
  );

  const saveActive = useCallback(async () => {
    const document = documentsRef.current.find((entry) => entry.id === activeDocumentIdRef.current);
    if (document) await saveDocument(document);
  }, [saveDocument]);

  const saveActiveAs = useCallback(async () => {
    const document = documentsRef.current.find((entry) => entry.id === activeDocumentIdRef.current);
    if (document) await saveDocumentAs(document);
  }, [saveDocumentAs]);

  const formatActive = useCallback(async () => {
    const document = documentsRef.current.find((entry) => entry.id === activeDocumentIdRef.current);
    if (document) await formatDocument(document);
  }, [formatDocument]);

  const saveDocumentById = useCallback(
    async (id: string) => {
      const document = documentsRef.current.find((entry) => entry.id === id);
      if (document) await saveDocument(document);
    },
    [saveDocument],
  );

  const saveDocumentAsById = useCallback(
    async (id: string) => {
      const document = documentsRef.current.find((entry) => entry.id === id);
      if (document) await saveDocumentAs(document);
    },
    [saveDocumentAs],
  );

  const closeDocumentById = useCallback(
    async (id: string) => {
      const closing = documentsRef.current.find((document) => document.id === id);
      if (!closing) return;
      if (closing.dirty && !(await confirmDirtyDocuments([closing], { kind: 'close-tab' }))) return;
      const oldDocuments = documentsRef.current;
      const closingIndex = oldDocuments.findIndex((document) => document.id === id);
      const next = oldDocuments.filter((document) => document.id !== closing.id);
      documentsRef.current = next;
      setDocuments(next);
      setActiveDocumentId((current) => {
        if (current !== closing.id) return current;
        return next[Math.min(closingIndex, next.length - 1)]?.id ?? next.at(-1)?.id ?? '';
      });
      window.setTimeout(ensureDocument, 0);
    },
    [confirmDirtyDocuments, ensureDocument],
  );

  const closeActive = useCallback(async () => {
    await closeDocumentById(activeDocumentIdRef.current);
  }, [closeDocumentById]);

  const closeFolder = useCallback(async () => {
    const currentFolder = folderRef.current;
    if (!currentFolder) return;
    const folderDocuments = documentsRef.current.filter(
      (document) => document.path && isPathInside(document.path, currentFolder.path),
    );
    if (
      !(await confirmDirtyDocuments(
        folderDocuments.filter((document) => document.dirty),
        { kind: 'close-folder' },
      ))
    ) {
      return;
    }
    await window.rmside.closeWorkspace();
    const closingIds = new Set(folderDocuments.map((document) => document.id));
    const next = documentsRef.current.filter((document) => !closingIds.has(document.id));
    documentsRef.current = next;
    setDocuments(next);
    setActiveDocumentId((current) => (closingIds.has(current) ? (next[0]?.id ?? '') : current));
    setFolder(null);
    setExpandedPaths([]);
    setSelectedPath(null);
    setMutationRevision((revision) => revision + 1);
    window.setTimeout(ensureDocument, 0);
  }, [confirmDirtyDocuments, ensureDocument]);

  const setDocumentContent = useCallback((id: string, content: string) => {
    updateDocuments(setDocuments, documentsRef, (current) =>
      current.map((document) =>
        document.id === id ? editedDocument(document, content) : document,
      ),
    );
  }, []);

  const adoptEditorText = useCallback((id: string, loaded: string, editorText: string) => {
    updateDocuments(setDocuments, documentsRef, (current) => {
      let changed = false;
      const next = current.map((document) => {
        if (document.id !== id) return document;
        const adopted = editorTextAdoption(document, loaded, editorText);
        if (!adopted) return document;
        changed = true;
        return { ...document, ...adopted };
      });
      return changed ? next : current;
    });
  }, []);

  const setDocumentViewState = useCallback((id: string, viewState: MonacoViewState | null) => {
    updateDocuments(setDocuments, documentsRef, (current) =>
      current.map((document) =>
        document.id === id &&
        JSON.stringify(document.viewState ?? null) !== JSON.stringify(viewState)
          ? { ...document, viewState }
          : document,
      ),
    );
  }, []);

  const promoteDocument = useCallback((id: string) => {
    updateDocuments(setDocuments, documentsRef, (current) =>
      current.map((document) =>
        document.id === id && !isUntitledDocument(document)
          ? { ...document, preview: false }
          : document,
      ),
    );
  }, []);

  const setFolderExpanded = useCallback((path: string, expanded: boolean) => {
    setExpandedPaths((current) => {
      const without = current.filter((entry) => pathKey(entry) !== pathKey(path));
      return expanded ? [...without, path] : without;
    });
  }, []);

  const reorderDocument = useCallback(
    (sourceId: string, targetId: string, placement: 'before' | 'after') => {
      if (sourceId === targetId) return;
      updateDocuments(setDocuments, documentsRef, (current) => {
        const source = current.find((document) => document.id === sourceId);
        const target = current.find((document) => document.id === targetId);
        if (!source || !target) return current;
        const withoutSource = current.filter((document) => document.id !== sourceId);
        const targetIndex = withoutSource.findIndex((document) => document.id === targetId);
        const insertionIndex = targetIndex + (placement === 'after' ? 1 : 0);
        const next = [...withoutSource];
        next.splice(insertionIndex, 0, source);
        return next.every((document, index) => document === current[index]) ? current : next;
      });
    },
    [],
  );

  const answerConfirmation = useCallback(
    (choice: ConfirmationChoice) => {
      const current = confirmation;
      if (!current) return;
      setConfirmation(null);
      current.resolve(choice);
    },
    [confirmation],
  );

  const dismissRecoveryNotice = useCallback(() => setRecoveryNotice(null), []);

  return useMemo(
    () => ({
      documents,
      activeDocument,
      activeDocumentId,
      folder,
      expandedPaths,
      selectedPath,
      lastNormalActivePath,
      lastSave,
      mutationRevision,
      sessionReady,
      restoredSession,
      recoveryNotice,
      confirmation,
      requestConfirmation,
      setActiveDocument: activateDocument,
      setDocumentContent,
      adoptEditorText,
      latestDocument,
      setDocumentViewState,
      promoteDocument,
      reorderDocument,
      setFolderExpanded,
      setSelectedPath,
      dismissRecoveryNotice,
      answerConfirmation,
      newFile,
      newMapTestScript,
      newXsScript,
      pickFiles,
      pickFolder,
      openRecent,
      openWorkspaceFile,
      openWorkspaceSource,
      acceptOpenResult,
      openDroppedFiles,
      createWorkspaceEntry,
      openGeneratedFile,
      renameWorkspaceEntry,
      deleteWorkspaceEntry,
      saveActive,
      saveActiveAs,
      formatActive,
      closeActive,
      saveDocumentById,
      saveDocumentAsById,
      closeDocumentById,
      closeFolder,
    }),
    [
      activeDocument,
      activeDocumentId,
      activateDocument,
      answerConfirmation,
      acceptOpenResult,
      closeActive,
      closeDocumentById,
      closeFolder,
      confirmation,
      createWorkspaceEntry,
      deleteWorkspaceEntry,
      dismissRecoveryNotice,
      documents,
      expandedPaths,
      folder,
      mutationRevision,
      newMapTestScript,
      newXsScript,
      newFile,
      openDroppedFiles,
      openGeneratedFile,
      openRecent,
      openWorkspaceFile,
      openWorkspaceSource,
      pickFiles,
      pickFolder,
      promoteDocument,
      reorderDocument,
      recoveryNotice,
      requestConfirmation,
      renameWorkspaceEntry,
      restoredSession,
      saveActive,
      saveActiveAs,
      formatActive,
      saveDocumentAsById,
      saveDocumentById,
      selectedPath,
      lastNormalActivePath,
      lastSave,
      sessionReady,
      setDocumentContent,
      adoptEditorText,
      latestDocument,
      setDocumentViewState,
      setFolderExpanded,
    ],
  );
}

function documentFromWorkspace(
  document: WorkspaceDocument,
  options: Partial<Pick<EditorDocument, 'editedThisOpenLifetime' | 'preview' | 'viewState'>> = {},
): EditorDocument {
  return {
    ...document,
    dirty: false,
    savedContent: document.content,
    preview: options.preview ?? false,
    editedThisOpenLifetime: options.editedThisOpenLifetime ?? false,
    viewState: options.viewState ?? null,
  };
}

function recoveryDocument(document: EditorDocument): RecoveryDocument {
  const {
    editedThisOpenLifetime: _edited,
    preview: _preview,
    savedContent: _saved,
    ...recovery
  } = document;
  return recovery;
}

function mergeRecovery(
  normalDocuments: EditorDocument[],
  recoveryDocuments: RecoveryDocument[],
): EditorDocument[] {
  const recovered = recoveryDocuments.map((document) => {
    const diskDocument = normalDocuments.find(
      (candidate) =>
        candidate.path && document.path && pathKey(candidate.path) === pathKey(document.path),
    );
    return {
      ...document,
      savedContent: diskDocument?.content ?? '\u0000',
      preview: false,
      editedThisOpenLifetime: true,
    };
  });
  const recoveredPaths = new Set(
    recovered.filter((entry) => entry.path).map((entry) => pathKey(entry.path!)),
  );
  return [
    ...normalDocuments.filter(
      (document) => !document.path || !recoveredPaths.has(pathKey(document.path)),
    ),
    ...recovered,
  ];
}

function replaceCleanPreviewOrAppend(
  current: EditorDocument[],
  document: EditorDocument,
): EditorDocument[] {
  const previewIndex = current.findIndex(isCleanPreview);
  if (previewIndex < 0) return [...current, document];
  const next = [...current];
  next.splice(previewIndex, 1, document);
  return next;
}

function updateDocuments(
  setDocuments: Dispatch<SetStateAction<EditorDocument[]>>,
  documentsRef: MutableRefObject<EditorDocument[]>,
  update: (current: EditorDocument[]) => EditorDocument[],
): void {
  const next = update(documentsRef.current);
  documentsRef.current = next;
  setDocuments(next);
}

function isPathInside(targetPath: string, folderPath: string): boolean {
  const target = pathKey(targetPath);
  const root = pathKey(folderPath).replace(/\/$/, '');
  return target === root || target.startsWith(`${root}/`);
}

function pathKey(path: string): string {
  return path.replaceAll('\\', '/').toLocaleLowerCase('en-US');
}

function basenameFromPath(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}

function remapPath(path: string | null, result: WorkspaceMutationResult): string | null {
  if (!path) return null;
  const containing = result.pathChanges
    .filter((candidate) => isPathInside(path, candidate.oldPath))
    .sort((left, right) => left.oldPath.length - right.oldPath.length)[0];
  return containing ? `${containing.newPath}${path.slice(containing.oldPath.length)}` : path;
}

function remapPaths(paths: string[], result: WorkspaceMutationResult): string[] {
  return paths.map((path) => remapPath(path, result) ?? path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reloadedNote(name: string): OutputMessage {
  return outputNote('Files', 'files.reloaded', {
    id: 'workspace.files.reloaded',
    args: { name },
  });
}

function formattingReason(
  outcome: { reason?: string | null; reasonText?: OutputText },
  fallback: MessageId,
): string | OutputText {
  if (outcome.reasonText) return outcome.reasonText;
  const reason = outcome.reason;
  if (reason === undefined || reason === null) return { id: fallback };
  const text = stripTransport(reason);
  if (/request timed out/u.test(text)) return { id: 'workspace.format.reason.timeout' };
  return engineSentence(text);
}

function formattingDetail(reason: string | undefined | null): { detail?: string } {
  return reason && stripTransport(reason) !== reason.trim() ? { detail: reason } : {};
}
