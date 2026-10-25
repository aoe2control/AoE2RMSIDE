import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ClipboardPaste, Copy, Scissors } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import type { WorkspaceDirectoryEntry } from '../shared/api';
import {
  explorerRowCommand,
  explorerRowCommandAllowed,
  type ExplorerRowTarget,
} from './explorer-row-commands';
import { useI18n } from './i18n';
import type { WorkspaceController } from './workspace-controller';

export interface ExplorerClipboardActions {
  canPaste: boolean;
  cutEntryId: string | null;
  copy(entry: WorkspaceDirectoryEntry): void;
  cut(entry: WorkspaceDirectoryEntry): void;
  paste(target: WorkspaceDirectoryEntry): void;
  refresh(): void;
}

export const ExplorerClipboardContext = createContext<ExplorerClipboardActions | null>(null);

export function useExplorerClipboardActions(
  workspace: WorkspaceController,
): ExplorerClipboardActions {
  const {
    explorerClipboard,
    mutationRevision,
    pasteIntoWorkspaceFolder,
    putOnExplorerClipboard,
    refreshExplorerClipboard,
  } = workspace;
  useEffect(() => {
    window.addEventListener('focus', refreshExplorerClipboard);
    return () => window.removeEventListener('focus', refreshExplorerClipboard);
  }, [refreshExplorerClipboard]);
  useEffect(() => refreshExplorerClipboard(), [mutationRevision, refreshExplorerClipboard]);
  return useMemo(
    () => ({
      canPaste: explorerClipboard.canPaste,
      cutEntryId: explorerClipboard.cutEntryId,
      copy: (entry) => void putOnExplorerClipboard(entry, 'copy'),
      cut: (entry) => void putOnExplorerClipboard(entry, 'cut'),
      paste: (target) => void pasteIntoWorkspaceFolder(target),
      refresh: refreshExplorerClipboard,
    }),
    [explorerClipboard, pasteIntoWorkspaceFolder, putOnExplorerClipboard, refreshExplorerClipboard],
  );
}

export function useExplorerRowKeys(
  target: ExplorerRowTarget,
  handlers: {
    rename(entry: WorkspaceDirectoryEntry): void;
    delete(entry: WorkspaceDirectoryEntry): void;
  },
): (event: KeyboardEvent<HTMLElement>) => void {
  const clipboard = useContext(ExplorerClipboardContext);
  return (event) => {
    if (event.target !== event.currentTarget || event.repeat) return;
    const command = explorerRowCommand(event);
    if (!command || !clipboard) return;
    event.preventDefault();
    if (!explorerRowCommandAllowed(command, target)) return;
    if (command === 'copy') clipboard.copy(target.entry);
    else if (command === 'cut') clipboard.cut(target.entry);
    else if (command === 'paste' && target.pasteTarget) clipboard.paste(target.pasteTarget);
    else if (command === 'rename') handlers.rename(target.entry);
    else if (command === 'delete') handlers.delete(target.entry);
  };
}

export function ExplorerClipboardMenuItems({
  target,
  withPaste,
}: {
  target: ExplorerRowTarget;
  withPaste: boolean;
}) {
  const { t } = useI18n();
  const clipboard = useContext(ExplorerClipboardContext);
  if (!clipboard) return null;
  return (
    <>
      {explorerRowCommandAllowed('cut', target) ? (
        <ContextMenuItem onClick={() => clipboard.cut(target.entry)}>
          <Scissors /> {t('explorer.context.cut')}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem onClick={() => clipboard.copy(target.entry)}>
        <Copy /> {t('explorer.context.copy')}
      </ContextMenuItem>
      {withPaste && target.pasteTarget && explorerRowCommandAllowed('paste', target) ? (
        <ExplorerPasteMenuItem target={target.pasteTarget} />
      ) : null}
    </>
  );
}

export function ExplorerPasteMenuItem({ target }: { target: WorkspaceDirectoryEntry }) {
  const { t } = useI18n();
  const clipboard = useContext(ExplorerClipboardContext);
  if (!clipboard) return null;
  return (
    <ContextMenuItem disabled={!clipboard.canPaste} onClick={() => clipboard.paste(target)}>
      <ClipboardPaste /> {t('explorer.context.paste')}
    </ContextMenuItem>
  );
}

export function ExplorerTreeArea({
  children,
  clipboard,
  menu,
}: {
  children: ReactNode;
  clipboard: ExplorerClipboardActions;
  menu: ReactNode;
}) {
  return (
    <ExplorerClipboardContext.Provider value={clipboard}>
      <ContextMenu
        onOpenChange={(open) => {
          if (open) clipboard.refresh();
        }}
      >
        <ContextMenuTrigger
          onContextMenu={(
            event: MouseEvent<HTMLDivElement> & { preventBaseUIHandler?(): void },
          ) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest('.explorer-inline-row')) event.preventBaseUIHandler?.();
          }}
          render={<div className="explorer-tree-area" data-explorer-tree-area />}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent className="explorer-context-menu">{menu}</ContextMenuContent>
      </ContextMenu>
    </ExplorerClipboardContext.Provider>
  );
}
