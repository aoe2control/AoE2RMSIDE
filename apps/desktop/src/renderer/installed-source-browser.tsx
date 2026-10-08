import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Castle, CloudDownload, Copy, HardDrive, Library, X } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { IconToggleButton } from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type {
  InstallationReport,
  InstalledSourceCatalog,
  InstalledSourceOriginFilter,
  InstalledSourceOwnership,
} from '../shared/api';
import type { MessageId } from '../shared/i18n/translator';
import {
  discoverGameInstallation,
  isUsableInstallation,
  onGameInstallationChanged,
  pickGameInstallation,
  refusedGameFolderText,
} from './game-installation';
import { userFacingErrorText } from '../shared/message-catalog';
import {
  outputNote,
  type OutputMessage,
  type OutputSource,
  type OutputWords,
} from '../shared/output-message';
import {
  filterInstalledSources,
  installedSourceEmptyState,
  installedSourceOriginCounts,
  installedSourceOrigins,
  toggleInstalledSourceOrigin,
} from './installed-source-filter';
import { installedSourceOriginLabel } from './installed-source-origin';
import { unresolvedDependencyNote } from './installed-source-notes';
import { useI18n } from './i18n';
import { SearchField } from './search-field';
import { SelectGameFolderButton } from './select-game-folder-button';
import type { WorkspaceController } from './workspace-controller';

const originIcons = {
  'built-in': Castle,
  local: HardDrive,
  subscribed: CloudDownload,
} as const satisfies Record<InstalledSourceOwnership, unknown>;

const originFilterLabels = {
  'built-in': 'installed-maps.filter.built-in',
  local: 'installed-maps.filter.local',
  subscribed: 'installed-maps.filter.subscribed',
} as const satisfies Record<InstalledSourceOwnership, MessageId>;

type InstalledSourceProblem =
  | { kind: 'error'; raw: string; source: OutputSource; fallback?: MessageId }
  | { kind: 'refused-folder'; report: InstallationReport };

function installedSourceProblemText(problem: InstalledSourceProblem): string {
  return problem.kind === 'refused-folder'
    ? refusedGameFolderText(problem.report)
    : userFacingErrorText(problem.raw, problem.source, problem.fallback);
}

export function InstalledSourceBrowser({
  appendOutput,
  onOpenChange,
  onOriginFilterChange,
  open,
  originFilter,
  workspace,
}: {
  appendOutput(message: OutputMessage): void;
  onOpenChange(open: boolean): void;
  onOriginFilterChange(filter: InstalledSourceOriginFilter): void;
  open: boolean;
  originFilter: InstalledSourceOriginFilter;
  workspace: WorkspaceController;
}) {
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<InstalledSourceCatalog | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectingFolder, setSelectingFolder] = useState(false);
  const [error, setError] = useState<InstalledSourceProblem | null>(null);
  const [installationRequired, setInstallationRequired] = useState(false);
  const [query, setQuery] = useState('');
  const [settledQuery, setSettledQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const sourceList = useRef<HTMLDivElement>(null);
  const selectingInstallation = useRef(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const installation = await discoverGameInstallation();
      if (!installation) {
        setCatalog(null);
        setInstallationRequired(true);
        return;
      }
      setInstallationRequired(false);
      const next = await window.rmside.discoverInstalledSources();
      setCatalog(next);
      for (const diagnostic of next.diagnostics) reportCatalogDiagnostic(appendOutput, diagnostic);
    } catch (refreshError) {
      setError({
        kind: 'error',
        raw: errorMessage(refreshError),
        source: 'Game folder',
        fallback: 'installed-maps.output.list-failed',
      });
    } finally {
      setBusy(false);
    }
  }, [appendOutput]);

  const selectGameFolder = useCallback(async () => {
    if (selectingInstallation.current) return;
    selectingInstallation.current = true;
    setSelectingFolder(true);
    setError(null);
    try {
      const report = await pickGameInstallation();
      setSelectingFolder(false);
      if (!report) return;
      if (!isUsableInstallation(report)) {
        setInstallationRequired(true);
        setError({ kind: 'refused-folder', report });
        return;
      }
      setInstallationRequired(false);
      setBusy(true);
      const next = await window.rmside.discoverInstalledSources();
      setCatalog(next);
      for (const diagnostic of next.diagnostics) reportCatalogDiagnostic(appendOutput, diagnostic);
    } catch (selectionError) {
      setError({ kind: 'error', raw: errorMessage(selectionError), source: 'Game folder' });
    } finally {
      selectingInstallation.current = false;
      setSelectingFolder(false);
      setBusy(false);
    }
  }, [appendOutput]);

  useEffect(() => {
    if (!open) return;
    setCatalog(null);
    setInstallationRequired(false);
    setQuery('');
    setSettledQuery('');
    setSearching(false);
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const next = query.trim();
    if (!open || !catalog || next.length === 0) {
      setSettledQuery('');
      setSearching(false);
      return undefined;
    }
    setSearching(true);
    const timer = window.setTimeout(() => {
      setSettledQuery(next);
      setSearching(false);
    }, 180);
    return () => window.clearTimeout(timer);
  }, [catalog, open, query]);

  const filteredSources = useMemo(
    () => filterInstalledSources(catalog?.entries ?? [], settledQuery, originFilter),
    [catalog, originFilter, settledQuery],
  );
  const originCounts = useMemo(
    () => installedSourceOriginCounts(catalog?.entries ?? [], settledQuery),
    [catalog, settledQuery],
  );
  const emptyState = catalog
    ? installedSourceEmptyState(catalog.entries, settledQuery, originFilter)
    : null;

  useEffect(
    () =>
      onGameInstallationChanged(() => {
        if (open && !selectingInstallation.current) void refresh();
      }),
    [open, refresh],
  );

  useEffect(() => {
    const viewport = sourceList.current;
    if (!open || !viewport) return undefined;
    let animationFrame = 0;
    const updateOverflowEdges = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        const maximumScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        viewport.dataset.overflowTop = String(viewport.scrollTop > 1);
        viewport.dataset.overflowBottom = String(viewport.scrollTop < maximumScrollTop - 1);
      });
    };
    const resizeObserver = new ResizeObserver(updateOverflowEdges);
    const mutationObserver = new MutationObserver(updateOverflowEdges);
    viewport.addEventListener('scroll', updateOverflowEdges, { passive: true });
    resizeObserver.observe(viewport);
    mutationObserver.observe(viewport, { childList: true, characterData: true, subtree: true });
    updateOverflowEdges();
    return () => {
      window.cancelAnimationFrame(animationFrame);
      viewport.removeEventListener('scroll', updateOverflowEdges);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
    };
  }, [catalog, open]);

  const openSource = async (sourceId: string) => {
    try {
      workspace.acceptOpenResult(await window.rmside.openInstalledSource(sourceId));
      onOpenChange(false);
    } catch (openError) {
      setError({
        kind: 'error',
        raw: errorMessage(openError),
        source: 'Files',
        fallback: 'installed-maps.open-failed',
      });
    }
  };

  const cloneSource = async (sourceId: string) => {
    try {
      const result = await window.rmside.cloneInstalledSource(sourceId);
      if (!result) return;
      workspace.acceptOpenResult(result.opened);
      appendOutput(
        outputNote('Files', 'files.cloned', {
          id: 'installed-maps.output.cloned',
          args: { count: result.copiedRelativePaths.length },
        }),
      );
      for (const dependency of result.unresolvedExternalDependencies) {
        appendOutput(unresolvedDependencyNote(dependency));
      }
      onOpenChange(false);
    } catch (cloneError) {
      setError({
        kind: 'error',
        raw: errorMessage(cloneError),
        source: 'Files',
        fallback: 'installed-maps.clone-failed',
      });
    }
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="installed-source-dialog"
        data-compact={(!busy && !catalog) || undefined}
        data-installation-required={installationRequired || undefined}
      >
        <DialogClose
          aria-label={t('installed-maps.close')}
          className="installed-source-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>
            <Library aria-hidden="true" /> {t('installed-maps.title')}
          </DialogTitle>
        </DialogHeader>
        {catalog && !installationRequired ? (
          <div className="installed-source-toolbar">
            <SearchField
              className="installed-source-search"
              clearLabel={t('installed-maps.search.clear')}
              label={t('installed-maps.search')}
              maxLength={256}
              onValueChange={setQuery}
              placeholder={t('installed-maps.search.placeholder')}
              value={query}
            />
            <div
              aria-label={t('installed-maps.filter.group')}
              className="installed-source-origin-filter"
              role="group"
            >
              {installedSourceOrigins.map((origin) => {
                const Icon = originIcons[origin];
                const label = t(originFilterLabels[origin], { count: originCounts[origin] });
                return (
                  <Tooltip disableHoverablePopup key={origin}>
                    <TooltipTrigger
                      delay={0}
                      render={
                        <IconToggleButton
                          aria-label={label}
                          className="installed-source-origin-toggle"
                          data-origin={origin}
                          onClick={() =>
                            onOriginFilterChange(toggleInstalledSourceOrigin(originFilter, origin))
                          }
                          pressed={originFilter[origin]}
                          size="icon-compact"
                        />
                      }
                    >
                      <Icon aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ) : null}
        <div
          className="installed-source-list owned-scrollbars"
          data-installation-required={installationRequired || undefined}
          ref={sourceList}
        >
          {(busy && !catalog && !installationRequired) || searching ? (
            <InstalledSourceSkeleton />
          ) : null}
          {!busy && installationRequired ? (
            <div className="installed-source-installation-prompt">
              <p>{t('installed-maps.select-game-folder')}</p>
              <SelectGameFolderButton
                aria-disabled={selectingFolder || undefined}
                onClick={() => {
                  if (!selectingFolder) void selectGameFolder();
                }}
                selecting={selectingFolder}
              />
            </div>
          ) : null}
          {!busy &&
          !searching &&
          !installationRequired &&
          (!catalog || emptyState === 'none-installed') ? (
            <p>{t('installed-maps.empty.none')}</p>
          ) : null}
          {!busy && !searching && emptyState === 'no-search-match' ? (
            <p>{t('installed-maps.empty.search')}</p>
          ) : null}
          {!busy && !searching && emptyState === 'no-origin' ? (
            <p>{t('installed-maps.empty.no-origin')}</p>
          ) : null}
          {!busy && !searching && emptyState === 'no-filter-match' ? (
            <p>
              {settledQuery
                ? t('installed-maps.empty.origins-search')
                : t('installed-maps.empty.origins')}
            </p>
          ) : null}
          {!searching
            ? filteredSources.map((source) => (
                <div className="installed-source-row" key={source.sourceId}>
                  <Button
                    aria-label={source.relativePath}
                    className="installed-source-open"
                    onClick={() => void openSource(source.sourceId)}
                    title={source.displayPath}
                    variant="ghost"
                  >
                    <span>{source.relativePath}</span>
                  </Button>
                  <div>
                    <span className="installed-source-origin" data-ownership={source.ownership}>
                      {installedSourceOriginLabel(source.ownership)}
                    </span>
                    <Button
                      className="installed-source-clone"
                      onClick={() => void cloneSource(source.sourceId)}
                      size="sm"
                      variant="ghost"
                    >
                      <Copy aria-hidden="true" /> {t('installed-maps.clone')}
                    </Button>
                  </div>
                </div>
              ))
            : null}
        </div>
        {error ? (
          <p className="installed-source-error" role="alert">
            {installedSourceProblemText(error)}
          </p>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function InstalledSourceSkeleton() {
  const { t } = useI18n();
  return (
    <div
      aria-label={t('installed-maps.loading')}
      className="installed-source-skeleton"
      role="status"
    >
      {Array.from({ length: 10 }, (_, index) => (
        <div className="installed-source-skeleton-row" key={index}>
          <span aria-hidden="true" className="installed-source-skeleton-path animate-pulse" />
          <span aria-hidden="true" className="installed-source-skeleton-action animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportCatalogDiagnostic(
  appendOutput: (message: OutputMessage) => void,
  diagnostic: OutputWords,
): void {
  if (typeof diagnostic === 'string' && /IDE-managed deployment output/u.test(diagnostic)) return;
  appendOutput(
    outputNote('Game folder', 'game-folder.installed-maps', diagnostic, { severity: 'warning' }),
  );
}
