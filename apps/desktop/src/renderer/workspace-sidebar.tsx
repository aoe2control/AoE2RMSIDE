import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { FolderIcon } from '@animateicons/react/lucide';
import {
  ChevronDown,
  ChevronRight,
  File,
  FileCode2,
  FileDigit,
  FilePlus2,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  Pencil,
  Trash2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  WorkspaceDirectoryEntry,
  WorkspaceEntryKind,
  WorkspaceSearchResult,
} from '../shared/api';
import { definitionFilesAvailable, editionCapabilities } from '../shared/edition';
import type { MessageId } from '../shared/i18n/translator';
import { inlineErrorText, userFacingErrorText } from '../shared/message-catalog';
import type { WorkspaceSearchNameRange } from '../shared/workspace-search';
import { useAnimatedIconHover } from './animated-icon';
import {
  buildExplorerSearchTree,
  explorerAncestorFolders,
  explorerFolderExpanded,
  explorerPathKey,
  explorerSearchInside,
  explorerSearchRows,
  visibleExplorerMatches,
  type ExplorerSearchTree,
} from './explorer-search-tree';
import { HoverMotionIcon } from './hover-motion-icon';
import { ListMotion, type ListMotionElements } from './list-motion';
import { useI18n } from './i18n';
import { OverflowingLabel } from './overflow-label';
import { RunningIndicator } from './running-indicator';
import { SearchField } from './search-field';
import type { WorkspaceController } from './workspace-controller';

interface WorkspaceSidebarProps {
  expanded: boolean;
  workspace: WorkspaceController;
  onGenerateDefinitionFile(folderId: string): void;
}

interface InlineDraft {
  mode: 'create' | 'rename';
  parentId: string;
  kind: WorkspaceEntryKind;
  entry?: WorkspaceDirectoryEntry;
  value: string;
  error: string | null;
  template?: CreateTemplate;
}

type CreateTemplate = 'map-test-v1' | 'xs-v1';

type CreateAction = CreateTemplate | 'definition-file';

interface SearchView {
  folderId: string;
  query: string;
  results: WorkspaceSearchResult[];
}

interface ExplorerSearchState {
  overrides: ReadonlyMap<string, boolean>;
  activeKey: string | null;
  tabStopKey: string | null;
  toggle(entry: WorkspaceDirectoryEntry, expanded: boolean): void;
}

const noSearchOverrides: ReadonlyMap<string, boolean> = new Map();

const ExplorerSearchContext = createContext<ExplorerSearchState>({
  activeKey: null,
  overrides: noSearchOverrides,
  tabStopKey: null,
  toggle: () => {},
});

function isEmptyInlineDraft(draft: InlineDraft, value = draft.value): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return (
    draft.mode === 'create' && draft.kind === 'file' && /^\.(?:rms|inc|rmstest|xs)$/i.test(trimmed)
  );
}

export const WorkspaceSidebar = memo(function WorkspaceSidebar({
  expanded,
  workspace,
  onGenerateDefinitionFile,
}: WorkspaceSidebarProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [searchView, setSearchView] = useState<SearchView | null>(null);
  const [searchOverrides, setSearchOverrides] = useState(noSearchOverrides);
  const [activeMatchKey, setActiveMatchKey] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchIndicatorVisible, setSearchIndicatorVisible] = useState(false);
  const [draft, setDraft] = useState<InlineDraft | null>(null);
  const createRequest = useRef(0);
  const [transientEntry, setTransientEntry] = useState<WorkspaceDirectoryEntry | null>(null);
  const explorerContentShell = useRef<HTMLDivElement>(null);
  const explorerContent = useRef<HTMLDivElement>(null);
  const explorerScrollbar = useRef<HTMLDivElement>(null);
  const explorerScrollbarThumb = useRef<HTMLDivElement>(null);
  const explorerFrame = useRef<HTMLDivElement>(null);
  const explorerGhosts = useRef<HTMLDivElement>(null);
  const openFileIcon = useAnimatedIconHover();
  const openFolderIcon = useAnimatedIconHover();
  const [treeMotion] = useState(
    () =>
      new ListMotion({
        cullToShell: true,
        ghostClassName: 'explorer-row explorer-tree-ghost',
        keyAttribute: 'rowKey',
        rowSelector: '.explorer-row[data-row-key]',
        skipUnrendered: true,
        valueSelector: '[data-list-value]',
      }),
  );
  const treeMotionPending = useRef(false);
  const pendingTreeScroll = useRef<{ scrollTop: number; revealKey: string | null } | null>(null);
  const searchStart = useRef<{ scrollTop: number; selectedPath: string | null } | null>(null);
  const searchViewRef = useRef(searchView);
  searchViewRef.current = searchView;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const activeScrollRequest = useRef(false);
  const pendingReveal = useRef<{ key: string; until: number } | null>(null);

  const treeMotionElements = (): ListMotionElements | null => {
    const shell = explorerFrame.current;
    const rows = explorerContent.current;
    const ghosts = explorerGhosts.current;
    return shell && rows && ghosts ? { ghosts, rows, shell } : null;
  };
  const recordTree = () => {
    const elements = treeMotionElements();
    if (!elements) return;
    treeMotion.record(elements);
    treeMotionPending.current = true;
  };

  const showSearchResults = (
    folderId: string,
    nextQuery: string,
    results: WorkspaceSearchResult[],
  ) => {
    const previous = searchViewRef.current;
    if (previous && previous.folderId !== folderId) {
      treeMotion.reset();
      treeMotionPending.current = false;
    } else recordTree();
    if (!previous || previous.folderId !== folderId) {
      searchStart.current = {
        scrollTop: explorerContent.current?.scrollTop ?? 0,
        selectedPath: workspaceRef.current.selectedPath,
      };
      pendingTreeScroll.current = { scrollTop: 0, revealKey: null };
    }
    setSearchView({ folderId, query: nextQuery, results });
    setSearchOverrides(noSearchOverrides);
    setActiveMatchKey(null);
  };

  const clearSearchView = () => {
    const current = workspaceRef.current;
    recordTree();
    const start = searchStart.current;
    searchStart.current = null;
    const selected = current.selectedPath;
    const moved =
      selected !== null &&
      current.folder !== null &&
      pathKey(selected) !== pathKey(start?.selectedPath ?? '');
    if (moved && current.folder) {
      for (const folder of explorerAncestorFolders(current.folder.path, selected)) {
        if (!current.expandedPaths.some((path) => pathKey(path) === pathKey(folder))) {
          current.setFolderExpanded(folder, true);
        }
      }
    }
    pendingTreeScroll.current = {
      scrollTop: start?.scrollTop ?? explorerContent.current?.scrollTop ?? 0,
      revealKey: moved ? pathKey(selected) : null,
    };
    setSearchView(null);
    setSearchOverrides(noSearchOverrides);
    setActiveMatchKey(null);
  };

  useEffect(() => {
    const shell = explorerContentShell.current;
    const viewport = explorerContent.current;
    const scrollbar = explorerScrollbar.current;
    const scrollbarThumb = explorerScrollbarThumb.current;
    if (!shell || !viewport || !scrollbar || !scrollbarThumb) return undefined;

    let animationFrame = 0;
    let scrollbarIdleTimer = 0;
    const updateOverflowEdges = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        const overflowTop = viewport.scrollTop > 1;
        const overflowBottom = viewport.scrollTop < maximumScrollTop - 1;
        const scrollable = maximumScrollTop > 1;
        const thumbHeight = scrollable
          ? Math.max(28, (viewport.clientHeight * viewport.clientHeight) / viewport.scrollHeight)
          : 0;
        const thumbTravel = Math.max(0, viewport.clientHeight - thumbHeight);
        const thumbOffset = scrollable ? (viewport.scrollTop / maximumScrollTop) * thumbTravel : 0;

        viewport.dataset.overflowTop = String(overflowTop);
        viewport.dataset.overflowBottom = String(overflowBottom);
        shell.dataset.overflowTop = String(overflowTop);
        shell.dataset.overflowBottom = String(overflowBottom);
        scrollbar.dataset.scrollable = String(scrollable);
        scrollbarThumb.style.height = `${thumbHeight}px`;
        scrollbarThumb.style.transform = `translateY(${thumbOffset}px)`;

        if (!scrollable) {
          window.clearTimeout(scrollbarIdleTimer);
          viewport.dataset.scrollbarVisible = 'false';
          scrollbar.dataset.visible = 'false';
        }
      });
    };
    const showScrollbar = () => {
      if (viewport.scrollHeight - viewport.clientHeight <= 1) return;
      window.clearTimeout(scrollbarIdleTimer);
      viewport.dataset.scrollbarVisible = 'true';
      scrollbar.dataset.visible = 'true';
      scrollbarIdleTimer = window.setTimeout(() => {
        viewport.dataset.scrollbarVisible = 'false';
        scrollbar.dataset.visible = 'false';
      }, 2_000);
    };
    const handleScroll = () => {
      updateOverflowEdges();
      showScrollbar();
    };
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const bounds = viewport.getBoundingClientRect();
      if (bounds.right - event.clientX <= 12 && viewport.scrollHeight > viewport.clientHeight) {
        showScrollbar();
      }
    };
    const resizeObserver = new ResizeObserver(updateOverflowEdges);
    const mutationObserver = new MutationObserver(updateOverflowEdges);

    viewport.dataset.scrollbarVisible = 'false';
    scrollbar.dataset.visible = 'false';
    shell.addEventListener('pointermove', handlePointerMove, { passive: true });
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    resizeObserver.observe(viewport);
    mutationObserver.observe(viewport, {
      attributeFilter: ['hidden'],
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    updateOverflowEdges();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(scrollbarIdleTimer);
      shell.removeEventListener('pointermove', handlePointerMove);
      viewport.removeEventListener('scroll', handleScroll);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    const viewport = explorerContent.current;
    if (!viewport) return undefined;
    const observer = new MutationObserver(() => {
      const pending = pendingReveal.current;
      if (!pending) return;
      if (performance.now() > pending.until) {
        pendingReveal.current = null;
        return;
      }
      const row = findExplorerRow(viewport, pending.key);
      if (!row) return;
      pendingReveal.current = null;
      revealWithin(viewport, row);
    });
    const giveUp = () => {
      pendingReveal.current = null;
    };
    observer.observe(viewport, { childList: true, subtree: true });
    viewport.addEventListener('wheel', giveUp, { passive: true });
    viewport.addEventListener('pointerdown', giveUp, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener('wheel', giveUp);
      viewport.removeEventListener('pointerdown', giveUp);
    };
  }, []);

  const searchQuery = query.trim();
  const folderId = workspace.folder?.id ?? null;
  useEffect(() => {
    if (!folderId || searchQuery.length === 0) {
      void window.rmside.cancelWorkspaceSearch().catch(() => undefined);
      setSearching(false);
      const view = searchViewRef.current;
      if (view && view.folderId === folderId) clearSearchView();
      else if (view) {
        treeMotion.reset();
        treeMotionPending.current = false;
        searchStart.current = null;
        setSearchView(null);
        setSearchOverrides(noSearchOverrides);
        setActiveMatchKey(null);
      }
      return undefined;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void window.rmside
        .searchWorkspace(searchQuery)
        .then((next) => {
          if (!cancelled) showSearchResults(folderId, searchQuery, next);
        })
        .catch(() => {
          if (!cancelled) showSearchResults(folderId, searchQuery, []);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void window.rmside.cancelWorkspaceSearch().catch(() => undefined);
    };
  }, [searchQuery, folderId, workspace.mutationRevision]);

  useEffect(() => {
    setSearchIndicatorVisible(false);
    if (!searching) return undefined;
    const timer = window.setTimeout(() => setSearchIndicatorVisible(true), 200);
    return () => window.clearTimeout(timer);
  }, [searching, workspace.folder?.id]);

  const rootEntry = useMemo<WorkspaceDirectoryEntry | null>(
    () =>
      workspace.folder
        ? {
            id: workspace.folder.id,
            path: workspace.folder.path,
            name: workspace.folder.name,
            kind: 'folder',
            writable: workspace.folder.writable,
            hasChildren: true,
          }
        : null,
    [workspace.folder],
  );

  const beginCreate = (
    parent: WorkspaceDirectoryEntry,
    kind: WorkspaceEntryKind,
    action?: CreateAction,
  ) => {
    const request = ++createRequest.current;
    setQuery('');
    workspace.setFolderExpanded(parent.path, true);
    workspace.setSelectedPath(parent.path);
    if (action === 'definition-file') {
      setDraft(null);
      onGenerateDefinitionFile(parent.id);
      return;
    }
    const template = action;
    const openDraft = (value: string) => {
      if (createRequest.current !== request) return;
      setDraft({
        mode: 'create',
        parentId: parent.id,
        kind,
        value,
        error: null,
        ...(template ? { template } : {}),
      });
    };
    if (template === 'map-test-v1') {
      void window.rmside
        .readDirectory(parent.id)
        .then((entries) => openDraft(nextMapTestScriptName(entries)))
        .catch(() => openDraft('Test1.rmstest'));
    } else if (template === 'xs-v1') {
      void window.rmside
        .readDirectory(parent.id)
        .then((entries) => openDraft(nextXsScriptName(entries)))
        .catch(() => openDraft('Script1.xs'));
    } else openDraft(kind === 'file' ? '.rms' : '');
  };

  const beginRename = (entry: WorkspaceDirectoryEntry) => {
    createRequest.current += 1;
    setDraft({
      mode: 'rename',
      parentId: '',
      kind: entry.kind,
      entry,
      value: entry.name,
      error: null,
    });
  };

  const commitDraft = async () => {
    if (!draft || isEmptyInlineDraft(draft)) return;
    try {
      if (draft.mode === 'create') {
        const result = await workspace.createWorkspaceEntry({
          parentId: draft.parentId,
          kind: draft.kind,
          name: draft.value,
          ...(draft.template ? { template: draft.template } : {}),
        });
        if (result.kind === 'folder' && result.entry) {
          setTransientEntry({ ...result.entry, hasChildren: false });
          workspace.setFolderExpanded(result.entry.path, true);
          workspace.setSelectedPath(result.entry.path);
        }
      } else if (draft.entry && draft.value !== draft.entry.name) {
        await workspace.renameWorkspaceEntry(draft.entry, draft.value);
      }
      setDraft(null);
    } catch (error) {
      setDraft((current) =>
        current
          ? {
              ...current,
              error: inlineErrorText(error instanceof Error ? error.message : String(error)),
            }
          : null,
      );
    }
  };

  const selectPath = (path: string) => {
    if (transientEntry && pathKey(path) !== pathKey(transientEntry.path)) setTransientEntry(null);
    workspace.setSelectedPath(path);
  };

  const searchTree = useMemo<ExplorerSearchTree | null>(
    () =>
      searchView && workspace.folder && searchView.folderId === workspace.folder.id
        ? buildExplorerSearchTree(workspace.folder.path, searchView.query, searchView.results)
        : null,
    [searchView, workspace.folder],
  );
  const visibleMatches = useMemo(
    () =>
      searchTree && workspace.folder
        ? visibleExplorerMatches(workspace.folder.path, searchTree, searchOverrides)
        : [],
    [searchOverrides, searchTree, workspace.folder],
  );
  const activeMatch =
    visibleMatches.find((entry) => pathKey(entry.path) === activeMatchKey) ?? visibleMatches[0];
  const activeKey = activeMatch ? pathKey(activeMatch.path) : null;
  const selectedKey = pathKey(workspace.selectedPath ?? '');
  const searchState = useMemo<ExplorerSearchState>(
    () => ({
      activeKey: searchTree ? activeKey : null,
      overrides: searchOverrides,
      tabStopKey: searchTree
        ? searchTree.shown.has(selectedKey) || selectedKey === pathKey(workspace.folder?.path ?? '')
          ? selectedKey
          : (activeKey ?? '')
        : null,
      toggle: (entry, expanded) => {
        recordTree();
        setSearchOverrides((current) => new Map(current).set(pathKey(entry.path), expanded));
      },
    }),
    [activeKey, searchOverrides, searchTree, selectedKey, workspace.folder?.path],
  );

  useLayoutEffect(() => {
    const viewport = explorerContent.current;
    const scroll = pendingTreeScroll.current;
    pendingTreeScroll.current = null;
    if (viewport && scroll) {
      viewport.scrollTop = scroll.scrollTop;
      const row = scroll.revealKey ? findExplorerRow(viewport, scroll.revealKey) : null;
      if (row) revealWithin(viewport, row);
      else if (scroll.revealKey) {
        pendingReveal.current = { key: scroll.revealKey, until: performance.now() + 2_000 };
      }
    }
    if (!treeMotionPending.current) return;
    treeMotionPending.current = false;
    const elements = treeMotionElements();
    if (elements) treeMotion.update(elements);
  }, [searchOverrides, searchTree, treeMotion]);

  useLayoutEffect(() => {
    if (!activeScrollRequest.current) return;
    activeScrollRequest.current = false;
    const viewport = explorerContent.current;
    const row = viewport && activeKey ? findExplorerRow(viewport, activeKey) : null;
    if (viewport && row) revealWithin(viewport, row);
  }, [activeKey]);

  const handleSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (visibleMatches.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const index = activeMatch ? visibleMatches.indexOf(activeMatch) : -1;
      const next = visibleMatches[(index + delta + visibleMatches.length) % visibleMatches.length];
      if (!next) return;
      activeScrollRequest.current = true;
      setActiveMatchKey(pathKey(next.path));
      return;
    }
    if (event.key === 'Enter' && searchTree && activeMatch) {
      event.preventDefault();
      selectPath(activeMatch.path);
      if (activeMatch.kind === 'file') {
        void workspace.openWorkspaceFile(activeMatch.path);
        return;
      }
      const key = pathKey(activeMatch.path);
      searchState.toggle(
        activeMatch,
        !explorerFolderExpanded(
          key,
          workspace.expandedPaths.some((path) => pathKey(path) === key),
          searchTree,
          searchOverrides,
        ),
      );
    }
  };

  return (
    <aside
      aria-hidden={!expanded}
      aria-label={t('explorer.label')}
      className="workspace-sidebar"
      data-expanded={expanded}
      inert={!expanded ? true : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && transientEntry && !draft && !query) {
          setTransientEntry(null);
        }
      }}
    >
      <div className="explorer-toolbar">
        <SearchField
          className="explorer-search"
          clearLabel={t('explorer.search.clear')}
          disabled={!workspace.folder}
          label={t('explorer.search.label')}
          maxLength={256}
          onKeyDown={handleSearchKey}
          onValueChange={setQuery}
          placeholder={t('explorer.search.placeholder')}
          value={query}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                {...openFileIcon.animationHandlers}
                aria-label={t('explorer.open-file.label')}
                onClick={() => void workspace.pickFiles()}
                size="icon-compact"
                variant="ghost"
              />
            }
          >
            <HoverMotionIcon aria-hidden="true" icon={File} ref={openFileIcon.iconRef} size={14} />
          </TooltipTrigger>
          <TooltipContent>{t('explorer.open-file.tooltip')}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                {...openFolderIcon.animationHandlers}
                aria-label={t('explorer.open-folder.label')}
                onClick={() => void workspace.pickFolder()}
                size="icon-compact"
                variant="ghost"
              />
            }
          >
            <FolderIcon aria-hidden="true" ref={openFolderIcon.iconRef} size={14} />
          </TooltipTrigger>
          <TooltipContent>{t('explorer.open-folder.tooltip')}</TooltipContent>
        </Tooltip>
      </div>

      <div
        className="explorer-content-shell"
        data-has-root={Boolean(workspace.folder && rootEntry)}
        ref={explorerContentShell}
      >
        <section
          aria-label={
            workspace.folder ? t('explorer.tree.label', { name: workspace.folder.name }) : undefined
          }
          className="explorer-tree"
          data-has-root={Boolean(workspace.folder && rootEntry)}
          onKeyDown={workspace.folder ? handleTreeNavigation : undefined}
          role={workspace.folder ? 'tree' : undefined}
        >
          {workspace.folder && rootEntry ? (
            <div className="explorer-root-pinned">
              <FolderRow
                entry={rootEntry}
                expanded
                isRoot
                onCreate={beginCreate}
                onDelete={() => {}}
                onRename={() => {}}
                onSelect={() => selectPath(rootEntry.path)}
                selected={pathKey(workspace.selectedPath ?? '') === pathKey(rootEntry.path)}
                searchBusy={Boolean(searchQuery) && searching && searchIndicatorVisible}
                tabStop={
                  searchState.tabStopKey === null
                    ? undefined
                    : searchState.tabStopKey === pathKey(rootEntry.path)
                }
              />
            </div>
          ) : null}
          <div className="explorer-content-frame" ref={explorerFrame}>
            <div
              className="explorer-content owned-scrollbars"
              data-scrollbar-visible="false"
              data-searching={searchTree ? true : undefined}
              ref={explorerContent}
            >
              {workspace.folder && rootEntry ? (
                <ExplorerSearchContext.Provider value={searchState}>
                  <DirectoryChildren
                    draft={draft}
                    mutationRevision={workspace.mutationRevision}
                    onCancelDraft={() => {
                      createRequest.current += 1;
                      setDraft(null);
                    }}
                    onCommitDraft={commitDraft}
                    onCreate={beginCreate}
                    onDelete={(entry) => void workspace.deleteWorkspaceEntry(entry)}
                    onDraftValueChange={(value) =>
                      setDraft((current) => (current ? { ...current, value, error: null } : null))
                    }
                    onRename={beginRename}
                    onSelect={selectPath}
                    parent={rootEntry}
                    search={searchTree}
                    transientEntry={transientEntry}
                    workspace={workspace}
                  />
                  {searchTree && searchTree.shown.size === 0 && !searching ? (
                    <div className="explorer-empty-folder">
                      {t(
                        editionCapabilities.newRmsScript
                          ? 'explorer.search.no-results.rms'
                          : 'explorer.search.no-results',
                      )}
                    </div>
                  ) : null}
                </ExplorerSearchContext.Provider>
              ) : (
                <Empty className="explorer-empty">
                  <EmptyHeader>
                    <EmptyDescription>
                      {t(
                        editionCapabilities.newRmsScript
                          ? 'explorer.empty.maps'
                          : 'explorer.empty.scripts',
                      )}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </div>
            <div aria-hidden="true" className="explorer-tree-ghosts" inert ref={explorerGhosts} />
          </div>
        </section>
        <div
          aria-hidden="true"
          className="explorer-scrollbar"
          data-scrollable="false"
          data-visible="false"
          ref={explorerScrollbar}
        >
          <div className="explorer-scrollbar-thumb" ref={explorerScrollbarThumb} />
        </div>
      </div>
    </aside>
  );
});

function ExplorerEntryLabel({
  children,
  match,
}: {
  children: string;
  match?: WorkspaceSearchNameRange | undefined;
}) {
  const highlighted = match && match.end > match.start;
  return (
    <OverflowingLabel
      className="explorer-entry-label"
      measure="hover"
      name={children}
      textClassName="explorer-entry-label-text"
    >
      {highlighted ? (
        <>
          {children.slice(0, match.start)}
          <mark className="explorer-entry-match">{children.slice(match.start, match.end)}</mark>
          {children.slice(match.end)}
        </>
      ) : undefined}
    </OverflowingLabel>
  );
}

function findExplorerRow(viewport: HTMLElement, key: string): HTMLElement | null {
  for (const row of viewport.querySelectorAll<HTMLElement>('.explorer-row[data-row-key]')) {
    if (row.dataset.rowKey === key && row.offsetParent !== null) return row;
  }
  return null;
}

function revealWithin(viewport: HTMLElement, row: HTMLElement): void {
  const viewportBox = viewport.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  if (rowBox.top < viewportBox.top) viewport.scrollTop -= viewportBox.top - rowBox.top;
  else if (rowBox.bottom > viewportBox.bottom) {
    viewport.scrollTop += rowBox.bottom - viewportBox.bottom;
  }
}

function ExplorerIndexPlaceholder({ label }: { label: string }) {
  return (
    <div aria-label={label} className="explorer-search-skeleton" role="status">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="explorer-search-skeleton-row" key={index}>
          <span aria-hidden="true" className="explorer-search-skeleton-icon animate-pulse" />
          <span aria-hidden="true" className="explorer-search-skeleton-line animate-pulse" />
        </div>
      ))}
    </div>
  );
}

interface DirectoryChildrenProps {
  parent: WorkspaceDirectoryEntry;
  workspace: WorkspaceController;
  draft: InlineDraft | null;
  transientEntry: WorkspaceDirectoryEntry | null;
  mutationRevision: number;
  depth?: number;
  search: ExplorerSearchTree | null;
  hidden?: boolean;
  onCreate(parent: WorkspaceDirectoryEntry, kind: WorkspaceEntryKind, action?: CreateAction): void;
  onRename(entry: WorkspaceDirectoryEntry): void;
  onDelete(entry: WorkspaceDirectoryEntry): void;
  onDraftValueChange(value: string): void;
  onSelect(path: string): void;
  onCommitDraft(): Promise<void>;
  onCancelDraft(): void;
}

function DirectoryChildren({
  parent,
  workspace,
  draft,
  transientEntry,
  mutationRevision,
  depth = 0,
  search,
  hidden = false,
  onCreate,
  onRename,
  onDelete,
  onDraftValueChange,
  onSelect,
  onCommitDraft,
  onCancelDraft,
}: DirectoryChildrenProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<WorkspaceDirectoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    void window.rmside
      .readDirectory(parent.id)
      .then((next) => {
        if (!cancelled) setEntries(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [mutationRevision, parent.id]);

  const shownHere = search?.children.get(pathKey(parent.path));
  if (!search || !shownHere) {
    if (hidden && (error !== null || !entries)) return null;
    if (error !== null) {
      return (
        <div className="explorer-error">
          {userFacingErrorText(error, 'Files', 'explorer.read-failed')}
        </div>
      );
    }
    if (!entries) {
      return search ? null : <ExplorerIndexPlaceholder label={t('explorer.indexing')} />;
    }
  }
  const loaded = error === null ? entries : null;
  const rows = search ? explorerSearchRows(loaded, shownHere ?? []) : (loaded ?? []);
  const provisionalHere = draft?.mode === 'create' && draft.parentId === parent.id;
  const transientHere =
    transientEntry &&
    pathKey(parent.path) === pathKey(parentPath(transientEntry.path)) &&
    !rows.some((entry) => pathKey(entry.path) === pathKey(transientEntry.path));
  const visible = transientHere ? [transientEntry, ...rows] : rows;
  if (visible.length === 0 && !provisionalHere) return null;
  return (
    <div className="directory-children" hidden={hidden || undefined} role="group">
      {provisionalHere ? (
        <InlineEditorRow
          draft={draft}
          depth={depth}
          onCancel={onCancelDraft}
          onCommit={onCommitDraft}
          onValueChange={onDraftValueChange}
        />
      ) : null}
      {visible.map((entry) => {
        const key = pathKey(entry.path);
        const filteredOut = search !== null && !search.shown.has(key);
        const renameDraft = draft?.mode === 'rename' && draft.entry?.id === entry.id;
        if (renameDraft && !filteredOut) {
          return (
            <InlineEditorRow
              draft={draft}
              depth={depth}
              key={entry.id}
              onCancel={onCancelDraft}
              onCommit={onCommitDraft}
              onValueChange={onDraftValueChange}
            />
          );
        }
        return entry.kind === 'folder' ? (
          <DirectoryFolder
            {...{
              draft,
              entry,
              mutationRevision,
              onCancelDraft,
              onCommitDraft,
              onCreate,
              onDelete,
              onDraftValueChange,
              onRename,
              onSelect,
              parent,
              search,
              transientEntry,
              workspace,
            }}
            depth={depth}
            key={entry.id}
          />
        ) : (
          <FileRow
            depth={depth}
            entry={entry}
            hidden={filteredOut}
            key={entry.id}
            match={search?.matches.get(key)}
            onDelete={onDelete}
            onOpen={(keepOpen) => {
              onSelect(entry.path);
              void workspace.openWorkspaceFile(entry.path, keepOpen);
            }}
            onRename={onRename}
            selected={
              pathKey(workspace.selectedPath ?? '') === key &&
              pathKey(workspace.activeDocument.path ?? '') === key
            }
          />
        );
      })}
    </div>
  );
}

function DirectoryFolder(props: DirectoryChildrenProps & { entry: WorkspaceDirectoryEntry }) {
  const { entry, workspace, depth = 0, search, onCreate, onRename, onDelete, onSelect } = props;
  const searchState = useContext(ExplorerSearchContext);
  const key = pathKey(entry.path);
  const userExpanded = workspace.expandedPaths.some((path) => pathKey(path) === key);
  const expanded = explorerFolderExpanded(key, userExpanded, search, searchState.overrides);
  const shownInSearch = search?.shown.has(key) ?? false;
  return (
    <div className="explorer-directory" hidden={(search !== null && !shownInSearch) || undefined}>
      <FolderRow
        depth={depth}
        entry={entry}
        expanded={expanded}
        match={search?.matches.get(key)}
        onCreate={onCreate}
        onDelete={onDelete}
        onRename={onRename}
        onSelect={() => {
          onSelect(entry.path);
          if (shownInSearch) searchState.toggle(entry, !expanded);
          else workspace.setFolderExpanded(entry.path, !expanded);
        }}
        selected={pathKey(workspace.selectedPath ?? '') === key}
        style={{ paddingLeft: `${6 + depth * 14}px` }}
      />
      {expanded || userExpanded ? (
        <DirectoryChildren
          {...props}
          depth={depth + 1}
          hidden={!expanded}
          parent={entry}
          search={explorerSearchInside(key, search)}
        />
      ) : null}
    </div>
  );
}

function FolderRow({
  entry,
  depth = 0,
  expanded,
  selected,
  isRoot = false,
  searchBusy = false,
  tabStop,
  match,
  style,
  onCreate,
  onRename,
  onDelete,
  onSelect,
}: {
  entry: WorkspaceDirectoryEntry;
  depth?: number;
  expanded: boolean;
  selected: boolean;
  isRoot?: boolean;
  searchBusy?: boolean;
  tabStop?: boolean | undefined;
  match?: WorkspaceSearchNameRange | undefined;
  style?: CSSProperties;
  onCreate(parent: WorkspaceDirectoryEntry, kind: WorkspaceEntryKind, action?: CreateAction): void;
  onRename(entry: WorkspaceDirectoryEntry): void;
  onDelete(entry: WorkspaceDirectoryEntry): void;
  onSelect(): void;
}) {
  const { t } = useI18n();
  const searchState = useContext(ExplorerSearchContext);
  const [contextOpen, setContextOpen] = useState(false);
  const key = pathKey(entry.path);
  const isTabStop =
    tabStop ?? (searchState.tabStopKey === null ? selected : searchState.tabStopKey === key);
  const row = (
    <div
      className="explorer-row"
      data-active={(!isRoot && searchState.activeKey === key) || undefined}
      data-context-open={contextOpen || undefined}
      data-kind="folder"
      data-match={match ? true : undefined}
      data-row-key={isRoot ? undefined : key}
      data-selected={selected}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-expanded={expanded}
              aria-level={isRoot ? 1 : depth + 2}
              aria-selected={selected}
              className="explorer-entry"
              data-root={isRoot || undefined}
              onClick={onSelect}
              role="treeitem"
              style={style}
              tabIndex={isTabStop ? 0 : -1}
              variant="ghost"
            />
          }
        >
          {isRoot ? <FolderOpen /> : expanded ? <ChevronDown /> : <ChevronRight />}
          <ExplorerEntryLabel match={match}>{entry.name}</ExplorerEntryLabel>
        </TooltipTrigger>
        <TooltipContent align="start" className="explorer-path-tooltip" side="right">
          {entry.path}
        </TooltipContent>
      </Tooltip>
      {entry.writable ? (
        <CreateMenu entry={entry} onCreate={onCreate} searching={searchBusy} selected={isTabStop} />
      ) : null}
      {isRoot ? (
        <span
          aria-hidden={!searchBusy}
          aria-label={t('explorer.search.searching')}
          className="explorer-search-indicator"
          data-active={searchBusy || undefined}
          role="status"
        >
          <RunningIndicator size={14} />
        </span>
      ) : null}
    </div>
  );
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="explorer-context-menu">
        <ContextMenuItem onClick={() => void window.rmside.openWorkspaceFolderInExplorer(entry.id)}>
          <FolderSearch /> {t('explorer.context.open-in-explorer')}
        </ContextMenuItem>
        {entry.writable ? (
          <>
            <ContextMenuSeparator />
            {editionCapabilities.newRmsScript ? (
              <ContextMenuItem onClick={() => onCreate(entry, 'file')}>
                <FilePlus2 /> {t('explorer.create.script')}
              </ContextMenuItem>
            ) : null}
            {editionCapabilities.mapTests ? (
              <ContextMenuItem onClick={() => onCreate(entry, 'file', 'map-test-v1')}>
                <FileCode2 /> {t('explorer.create.map-test-script')}
              </ContextMenuItem>
            ) : null}
            {definitionFilesAvailable(editionCapabilities) ? (
              <ContextMenuItem onClick={() => onCreate(entry, 'file', 'definition-file')}>
                <FileDigit /> {t('explorer.create.definition-file')}
              </ContextMenuItem>
            ) : null}
            <ContextMenuItem onClick={() => onCreate(entry, 'file', 'xs-v1')}>
              <FileCode2 /> {t('explorer.create.xs-script')}
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onCreate(entry, 'folder')}>
              <FolderPlus /> {t('explorer.create.folder')}
            </ContextMenuItem>
            {!isRoot ? (
              <>
                <ContextMenuSeparator />
                <ContextMenuItem onClick={() => onRename(entry)}>
                  <Pencil /> {t('explorer.context.rename')}
                </ContextMenuItem>
                <ContextMenuItem onClick={() => onDelete(entry)} variant="destructive">
                  <Trash2 /> {t('explorer.context.delete')}
                </ContextMenuItem>
              </>
            ) : null}
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}

function FileRow({
  entry,
  selected,
  depth,
  hidden = false,
  match,
  onOpen,
  onRename,
  onDelete,
}: {
  entry: WorkspaceDirectoryEntry;
  selected: boolean;
  depth: number;
  hidden?: boolean;
  match?: WorkspaceSearchNameRange | undefined;
  onOpen(keepOpen: boolean): void;
  onRename(entry: WorkspaceDirectoryEntry): void;
  onDelete(entry: WorkspaceDirectoryEntry): void;
}) {
  const { t } = useI18n();
  const searchState = useContext(ExplorerSearchContext);
  const [contextOpen, setContextOpen] = useState(false);
  const key = pathKey(entry.path);
  const isTabStop = searchState.tabStopKey === null ? selected : searchState.tabStopKey === key;
  const row = (
    <div
      className="explorer-row"
      data-active={searchState.activeKey === key || undefined}
      data-context-open={contextOpen || undefined}
      data-kind="file"
      data-match={match ? true : undefined}
      data-row-key={key}
      data-selected={selected}
      hidden={hidden || undefined}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-level={depth + 2}
              aria-selected={selected}
              className="explorer-entry"
              onClick={() => onOpen(false)}
              onDoubleClick={() => onOpen(true)}
              role="treeitem"
              style={{ paddingLeft: `${12 + depth * 14}px` }}
              tabIndex={isTabStop ? 0 : -1}
              variant="ghost"
            />
          }
        >
          <FileCode2 />
          <ExplorerEntryLabel match={match}>{entry.name}</ExplorerEntryLabel>
        </TooltipTrigger>
        <TooltipContent align="start" className="explorer-path-tooltip" side="right">
          {entry.path}
        </TooltipContent>
      </Tooltip>
    </div>
  );
  if (!entry.writable) return row;
  return (
    <ContextMenu onOpenChange={setContextOpen}>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="explorer-context-menu">
        <ContextMenuItem onClick={() => onRename(entry)}>
          <Pencil /> {t('explorer.context.rename')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => onDelete(entry)} variant="destructive">
          <Trash2 /> {t('explorer.context.delete')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CreateMenu({
  entry,
  onCreate,
  searching = false,
  selected,
}: {
  entry: WorkspaceDirectoryEntry;
  selected: boolean;
  searching?: boolean;
  onCreate(parent: WorkspaceDirectoryEntry, kind: WorkspaceEntryKind, action?: CreateAction): void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={t('explorer.create.label', { name: entry.name })}
            className="explorer-create-action"
            data-searching={searching || undefined}
            disabled={searching}
            onClick={(event) => event.stopPropagation()}
            size="icon-xs"
            tabIndex={selected && !searching ? 0 : -1}
            variant="ghost"
          />
        }
      >
        <FilePlus2 />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="explorer-create-menu">
        {editionCapabilities.newRmsScript ? (
          <DropdownMenuItem onClick={() => onCreate(entry, 'file')}>
            <FilePlus2 /> {t('explorer.create.script')}
          </DropdownMenuItem>
        ) : null}
        {editionCapabilities.mapTests ? (
          <DropdownMenuItem onClick={() => onCreate(entry, 'file', 'map-test-v1')}>
            <FileCode2 /> {t('explorer.create.map-test-script')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => onCreate(entry, 'file', 'xs-v1')}>
          <FileCode2 /> {t('explorer.create.xs-script')}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onCreate(entry, 'folder')}>
          <FolderPlus /> {t('explorer.create.folder')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InlineEditorRow({
  draft,
  depth,
  onCommit,
  onCancel,
  onValueChange,
}: {
  draft: InlineDraft;
  depth: number;
  onCommit(): Promise<void>;
  onCancel(): void;
  onValueChange(value: string): void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      input.current?.focus();
      if (draft.mode === 'rename') input.current?.select();
      else if (draft.kind === 'file') {
        input.current?.setSelectionRange(
          0,
          draft.template === 'map-test-v1'
            ? draft.value.length - '.rmstest'.length
            : draft.template === 'xs-v1'
              ? draft.value.length - '.xs'.length
              : 0,
        );
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft.kind, draft.mode, draft.template]);
  return (
    <div
      aria-level={depth + 2}
      className="explorer-inline-row"
      role="treeitem"
      style={{ paddingLeft: `${12 + depth * 14}px` }}
    >
      {draft.kind === 'file' ? <FileCode2 /> : <ChevronRight />}
      <div className="explorer-inline-input">
        <Input
          aria-label={t(inlineEditorLabels[draft.mode][draft.kind])}
          aria-invalid={Boolean(draft.error)}
          onBlur={onCancel}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (!isEmptyInlineDraft(draft, event.currentTarget.value)) void onCommit();
            }
          }}
          ref={input}
          value={draft.value}
        />
        {draft.error ? <span className="explorer-inline-error">{draft.error}</span> : null}
      </div>
    </div>
  );
}

const inlineEditorLabels: Readonly<
  Record<InlineDraft['mode'], Readonly<Record<WorkspaceEntryKind, MessageId>>>
> = {
  create: { file: 'explorer.inline.create-file', folder: 'explorer.inline.create-folder' },
  rename: { file: 'explorer.inline.rename-file', folder: 'explorer.inline.rename-folder' },
};

function parentPath(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

const pathKey = explorerPathKey;

function nextMapTestScriptName(entries: WorkspaceDirectoryEntry[]): string {
  const occupied = new Set(entries.map((entry) => entry.name.toLocaleLowerCase('en-US')));
  for (let index = 1; index <= entries.length + 1; index += 1) {
    const name = `Test${index}.rmstest`;
    if (!occupied.has(name.toLocaleLowerCase('en-US'))) return name;
  }
  return `Test${entries.length + 2}.rmstest`;
}

function nextXsScriptName(entries: WorkspaceDirectoryEntry[]): string {
  const occupied = new Set(entries.map((entry) => entry.name.toLocaleLowerCase('en-US')));
  for (let index = 1; index <= entries.length + 1; index += 1) {
    const name = `Script${index}.xs`;
    if (!occupied.has(name.toLocaleLowerCase('en-US'))) return name;
  }
  return `Script${entries.length + 2}.xs`;
}

function handleTreeNavigation(event: KeyboardEvent<HTMLElement>): void {
  const item =
    event.target instanceof HTMLElement
      ? event.target.closest<HTMLElement>('[role="treeitem"]')
      : null;
  if (!item || event.target !== item) return;
  const tree = event.currentTarget;
  const items = Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
    (candidate) => candidate.getClientRects().length > 0,
  );
  const index = items.indexOf(item);
  if (index < 0) return;

  let next: HTMLElement | undefined;
  if (event.key === 'ArrowDown') next = items[index + 1];
  else if (event.key === 'ArrowUp') next = items[index - 1];
  else if (event.key === 'Home') next = items[0];
  else if (event.key === 'End') next = items.at(-1);
  else if (event.key === 'ArrowRight' && item.hasAttribute('aria-expanded')) {
    if (item.getAttribute('aria-expanded') === 'false') item.click();
    else next = items[index + 1];
  } else if (event.key === 'ArrowLeft') {
    if (item.getAttribute('aria-expanded') === 'true' && !item.dataset.root) item.click();
    else {
      const group = item.closest<HTMLElement>('[role="group"]');
      const parent = group?.parentElement?.querySelector<HTMLElement>('[role="treeitem"]');
      if (parent && parent !== item) next = parent;
    }
  } else {
    return;
  }
  event.preventDefault();
  next?.focus();
}
