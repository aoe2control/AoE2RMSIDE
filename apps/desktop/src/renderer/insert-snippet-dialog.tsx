import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Pencil, Trash2, X } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleButton } from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { OwnSnippetImportResult } from '../shared/api';
import type { MessageId } from '../shared/i18n/translator';
import { snippetNameKey, type OwnSnippet } from '../shared/own-snippets';
import { useI18n } from './i18n';
import { SearchField } from './search-field';
import {
  snippetListEmptyState,
  snippetListIndexAfterKey,
  snippetSectionHeaders,
  visibleSnippets,
  type EditorSnippet,
} from './insert-snippet';
import type { EditorColorHalf } from './editor-color-schemes';
import { SaveSnippetDialog, type SaveSnippetDialogState } from './save-snippet-dialog';
import { snippetPreviewColor, snippetPreviewSpans } from './snippet-preview-colors';
import {
  sectionHeader,
  type SnippetPlacement,
  type SnippetPlacementMode,
} from './snippet-placement';

export interface InsertSnippetDialogState {
  id: number;
  open: boolean;
  status: 'loading' | 'ready' | 'failed';
  snippets: readonly EditorSnippet[];
}

interface DialogNotice {
  kind: 'status' | 'alert';
  id: MessageId;
  args?: Record<string, string | number>;
}

const importRefusalWords: Readonly<
  Record<Extract<OwnSnippetImportResult, { status: 'refused' }>['reason'], MessageId>
> = {
  format: 'code-editor.snippets.import.refused.format',
  version: 'code-editor.snippets.import.refused.version',
  invalid: 'code-editor.snippets.import.refused.invalid',
  'duplicate-name': 'code-editor.snippets.import.refused.invalid',
  'too-many': 'code-editor.snippets.import.refused.too-many',
  'too-large': 'code-editor.snippets.import.refused.too-large',
  unreadable: 'code-editor.snippets.import.refused.unreadable',
};

export function InsertSnippetDialog({
  state,
  colors,
  onClose,
  onInsert,
  placementFor,
  onOwnSnippetsChanged,
}: {
  state: InsertSnippetDialogState;
  colors: EditorColorHalf;
  onClose(): void;
  onInsert(snippet: EditorSnippet, mode: SnippetPlacementMode): void;
  placementFor(snippet: EditorSnippet): SnippetPlacement;
  onOwnSnippetsChanged(snippets: OwnSnippet[]): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    snippet: EditorSnippet;
    placement: Exclude<SnippetPlacement, { kind: 'caret' }>;
  } | null>(null);
  const [deleting, setDeleting] = useState<OwnSnippet | null>(null);
  const [editing, setEditing] = useState<SaveSnippetDialogState>({
    id: 0,
    open: false,
    previousName: null,
    initial: { name: '', section: 'any', description: '', body: '' },
    existing: [],
  });
  const [notice, setNotice] = useState<DialogNotice | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const search = useRef<HTMLInputElement | null>(null);
  const leaving = useRef(false);
  const placementAction = useRef<HTMLButtonElement | null>(null);
  const deleteAction = useRef<HTMLButtonElement | null>(null);
  const options = useRef(new Map<string, HTMLDivElement>());
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    setQuery('');
    setShowAll(false);
    setActiveId(null);
    setPending(null);
    setDeleting(null);
    setEditing((current) => ({ ...current, open: false }));
    setNotice(null);
    leaving.current = false;
  }, [state.id]);

  const ownSnippets = useMemo(
    () => state.snippets.flatMap((snippet) => (snippet.own ? [snippet.own] : [])),
    [state.snippets],
  );
  const hasOwn = ownSnippets.length > 0;
  const shown = useMemo(
    () => (state.status === 'ready' ? visibleSnippets(state.snippets, query, showAll) : []),
    [query, showAll, state.snippets, state.status],
  );
  const shownOwn = shown.filter((snippet) => snippet.own);
  const shownBuiltIn = shown.filter((snippet) => !snippet.own);
  const activeIndex = Math.max(
    0,
    shown.findIndex((snippet) => snippet.id === activeId),
  );
  const active = shown[activeIndex] ?? null;
  const emptyState =
    state.status === 'ready' ? snippetListEmptyState(state.snippets, query, showAll) : null;

  useEffect(() => {
    if (!active) return;
    options.current.get(active.id)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (snippet: EditorSnippet) => {
    const placement = placementFor(snippet);
    if (placement.kind === 'caret') onInsert(snippet, 'caret');
    else setPending({ snippet, placement });
  };
  const insertPending = (mode: SnippetPlacementMode) => {
    if (!pending) return;
    leaving.current = true;
    setPending(null);
    onInsert(pending.snippet, mode);
  };
  const backToSearch = () => (leaving.current ? false : (search.current ?? true));

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
      return;
    }
    const next = snippetListIndexAfterKey(event.key, activeIndex, shown.length);
    if (next === null) return;
    event.preventDefault();
    setActiveId(shown[next]?.id ?? null);
  };

  const editSnippet = (own: OwnSnippet) => {
    setNotice(null);
    setEditing((current) => ({
      id: current.id + 1,
      open: true,
      previousName: own.name,
      initial: own,
      existing: ownSnippets,
    }));
  };

  const deleteSnippet = async (own: OwnSnippet) => {
    setDeleting(null);
    try {
      onOwnSnippetsChanged(await window.rmside.deleteOwnSnippet(own.name));
      setNotice(null);
    } catch {
      setNotice({ kind: 'alert', id: 'code-editor.snippets.delete.failed' });
    }
  };

  const exportSnippets = async () => {
    if (fileBusy) return;
    setFileBusy(true);
    setNotice(null);
    try {
      const exported = await window.rmside.exportOwnSnippets();
      if (exported) {
        setNotice({
          kind: 'status',
          id: 'code-editor.snippets.exported',
          args: { count: exported.count },
        });
      }
    } catch {
      setNotice({ kind: 'alert', id: 'code-editor.snippets.export.failed' });
    } finally {
      setFileBusy(false);
      search.current?.focus();
    }
  };

  const importSnippets = async () => {
    if (fileBusy) return;
    setFileBusy(true);
    setNotice(null);
    try {
      const result = await window.rmside.importOwnSnippets();
      if (result?.status === 'imported') {
        onOwnSnippetsChanged(result.snippets);
        const { renamed } = result;
        setNotice(
          renamed > 0
            ? {
                kind: 'status',
                id: 'code-editor.snippets.imported.renamed',
                args: { count: result.added.length, renamed },
              }
            : {
                kind: 'status',
                id: 'code-editor.snippets.imported',
                args: { count: result.added.length },
              },
        );
      } else if (result?.status === 'refused') {
        setNotice({ kind: 'alert', id: importRefusalWords[result.reason] });
      }
    } catch {
      setNotice({ kind: 'alert', id: 'code-editor.snippets.import.failed' });
    } finally {
      setFileBusy(false);
      search.current?.focus();
    }
  };

  const sections = active ? snippetSectionHeaders(active) : [];
  const previewLines = useMemo(
    () => (active ? snippetPreviewSpans(active.preview, active.previewTokens) : []),
    [active],
  );
  const pendingSection = pending ? sectionHeader(pending.placement.section) : '';

  const option = (snippet: EditorSnippet, index: number) => {
    const selected = snippet === active;
    const own = snippet.own;
    return (
      <div
        aria-selected={selected}
        className="insert-snippet-option"
        data-active={selected || undefined}
        data-own={own ? true : undefined}
        data-snippet-id={snippet.id}
        id={optionId(index)}
        key={snippet.id}
        onClick={() => choose(snippet)}
        onMouseDown={(event) => event.preventDefault()}
        onPointerMove={() => {
          if (!selected) setActiveId(snippet.id);
        }}
        ref={(element) => {
          if (element) options.current.set(snippet.id, element);
          else options.current.delete(snippet.id);
        }}
        role="option"
      >
        <span className="insert-snippet-option-text">
          <span className="insert-snippet-option-label">{snippet.label}</span>
          {snippet.summary ? (
            <span className="insert-snippet-option-summary">{snippet.summary}</span>
          ) : null}
        </span>
        {own ? (
          <span className="insert-snippet-option-actions">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t('code-editor.snippets.edit.named', { name: own.name })}
                    className="insert-snippet-option-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      editSnippet(own);
                    }}
                    size="icon-compact"
                    tabIndex={selected ? 0 : -1}
                    variant="ghost"
                  />
                }
              >
                <Pencil aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="insert-snippet-option-tooltip">
                {t('code-editor.snippets.edit')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={t('code-editor.snippets.delete.named', { name: own.name })}
                    className="insert-snippet-option-action"
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleting(own);
                    }}
                    size="icon-compact"
                    tabIndex={selected ? 0 : -1}
                    variant="ghost"
                  />
                }
              >
                <Trash2 aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="insert-snippet-option-tooltip">
                {t('code-editor.snippets.delete')}
              </TooltipContent>
            </Tooltip>
          </span>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={state.open}
    >
      <DialogContent
        className="insert-snippet-dialog"
        data-editing={editing.open || undefined}
        data-testid="insert-snippet-dialog"
        finalFocus={false}
        initialFocus={search}
      >
        <DialogClose
          aria-label={t('code-editor.snippets.close')}
          className="insert-snippet-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>{t('code-editor.snippets.title')}</DialogTitle>
        </DialogHeader>
        <div className="insert-snippet-toolbar">
          <SearchField
            className="insert-snippet-search"
            clearLabel={t('code-editor.snippets.search.clear')}
            combobox={{
              controls: listId,
              activeDescendant: active ? optionId(activeIndex) : undefined,
            }}
            inputRef={search}
            label={t('code-editor.snippets.search')}
            maxLength={128}
            onKeyDown={onSearchKeyDown}
            onValueChange={(value) => {
              setQuery(value);
              setActiveId(null);
            }}
            placeholder={t('code-editor.snippets.search.placeholder')}
            value={query}
          />
          <ToggleButton
            checked={showAll}
            className="insert-snippet-show-all"
            density="compact"
            onClick={() => {
              setShowAll((current) => !current);
              setActiveId(null);
            }}
          >
            {t('code-editor.snippets.show-all')}
          </ToggleButton>
        </div>
        <div className="insert-snippet-body">
          <div
            aria-label={t('code-editor.snippets.list')}
            className="insert-snippet-list owned-scrollbars"
            id={listId}
            role="listbox"
          >
            {state.status === 'loading' ? (
              <p className="insert-snippet-status" role="status">
                {t('code-editor.snippets.loading')}
              </p>
            ) : null}
            {state.status === 'failed' ? (
              <p className="insert-snippet-status" role="alert">
                {t('code-editor.snippets.unavailable')}
              </p>
            ) : null}
            {emptyState === 'none-here' ? (
              <p className="insert-snippet-status">{t('code-editor.snippets.empty.here')}</p>
            ) : null}
            {emptyState === 'no-search-match' ? (
              <p className="insert-snippet-status">{t('code-editor.snippets.empty.search')}</p>
            ) : null}
            {hasOwn && shownOwn.length > 0 ? (
              <div
                aria-labelledby={`${listId}-own`}
                className="insert-snippet-group"
                data-testid="insert-snippet-own-group"
                role="group"
              >
                <div className="insert-snippet-group-heading" id={`${listId}-own`}>
                  {t('code-editor.snippets.group.own')}
                </div>
                {shownOwn.map((snippet, index) => option(snippet, index))}
              </div>
            ) : null}
            {hasOwn && shownBuiltIn.length > 0 ? (
              <div
                aria-labelledby={`${listId}-built-in`}
                className="insert-snippet-group"
                role="group"
              >
                <div className="insert-snippet-group-heading" id={`${listId}-built-in`}>
                  {t('code-editor.snippets.group.built-in')}
                </div>
                {shownBuiltIn.map((snippet, index) => option(snippet, shownOwn.length + index))}
              </div>
            ) : null}
            {!hasOwn ? shownBuiltIn.map((snippet, index) => option(snippet, index)) : null}
          </div>
          <div className="insert-snippet-preview">
            <div className="insert-snippet-preview-heading">
              <span>{t('code-editor.snippets.preview')}</span>
              {sections.map((section) => (
                <code className="insert-snippet-preview-section" dir="ltr" key={section}>
                  {section}
                </code>
              ))}
            </div>
            <pre
              className="insert-snippet-preview-code owned-scrollbars"
              data-testid="insert-snippet-preview"
              dir="ltr"
              style={{ color: colors.code.text }}
            >
              {previewLines.map((line, lineIndex) => (
                <Fragment key={lineIndex}>
                  {lineIndex > 0 ? '\n' : null}
                  {line.map((span, index) =>
                    span.role ? (
                      <span
                        data-role={span.role}
                        key={index}
                        style={{ color: snippetPreviewColor(colors, span.role) }}
                      >
                        {span.text}
                      </span>
                    ) : (
                      span.text
                    ),
                  )}
                </Fragment>
              ))}
            </pre>
          </div>
        </div>
        <div className="insert-snippet-footer">
          <div className="insert-snippet-file-actions">
            <Button disabled={fileBusy} onClick={() => void importSnippets()} variant="ghost">
              {t('code-editor.snippets.import')}
            </Button>
            {hasOwn ? (
              <Button disabled={fileBusy} onClick={() => void exportSnippets()} variant="ghost">
                {t('code-editor.snippets.export')}
              </Button>
            ) : null}
          </div>
          <p
            aria-live="polite"
            className="insert-snippet-notice"
            data-kind={notice?.kind}
            data-testid="insert-snippet-notice"
            role={notice?.kind === 'alert' ? 'alert' : 'status'}
          >
            {notice ? t(notice.id, notice.args) : null}
          </p>
          <div className="insert-snippet-actions">
            <DialogClose variant="secondary">{t('code-editor.snippets.cancel')}</DialogClose>
            <Button disabled={!active} onClick={() => active && choose(active)}>
              {t('code-editor.snippets.insert')}
            </Button>
          </div>
        </div>

        <AlertDialog
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          open={pending !== null}
        >
          <AlertDialogContent
            data-testid="snippet-placement-confirmation"
            finalFocus={backToSearch}
            initialFocus={placementAction}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {pending?.placement.kind === 'missing'
                  ? t('code-editor.snippets.place.create.title', { section: pendingSection })
                  : t('code-editor.snippets.place.end.title', { section: pendingSection })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {pending?.placement.kind === 'missing'
                  ? t('code-editor.snippets.place.create.description', {
                      section: pendingSection,
                    })
                  : t('code-editor.snippets.place.end.description', { section: pendingSection })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('code-editor.snippets.place.cancel')}</AlertDialogCancel>
              <Button onClick={() => insertPending('caret')} variant="secondary">
                {t('code-editor.snippets.place.here')}
              </Button>
              <AlertDialogAction
                onClick={() =>
                  insertPending(
                    pending?.placement.kind === 'missing' ? 'create-section' : 'section-end',
                  )
                }
                ref={placementAction}
              >
                {pending?.placement.kind === 'missing'
                  ? t('code-editor.snippets.place.create.confirm')
                  : t('code-editor.snippets.place.end.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          onOpenChange={(open) => {
            if (!open) setDeleting(null);
          }}
          open={deleting !== null}
        >
          <AlertDialogContent
            data-testid="snippet-delete-confirmation"
            finalFocus={search}
            initialFocus={deleteAction}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('code-editor.snippets.delete.title', { name: deleting?.name ?? '' })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('code-editor.snippets.delete.description')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('code-editor.snippets.delete.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  if (deleting) void deleteSnippet(deleting);
                }}
                ref={deleteAction}
                variant="destructive"
              >
                {t('code-editor.snippets.delete.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <SaveSnippetDialog
          finalFocus={search}
          nested
          onClose={() => setEditing((current) => ({ ...current, open: false }))}
          onSaved={(snippets, saved) => {
            setEditing((current) => ({ ...current, open: false }));
            onOwnSnippetsChanged(snippets);
            setActiveId(`own:${snippetNameKey(saved.name)}`);
          }}
          state={editing}
        />
      </DialogContent>
    </Dialog>
  );
}
