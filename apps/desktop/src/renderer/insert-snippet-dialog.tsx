import { Fragment, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ToggleButton } from '@/components/ui/toggle-button';
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
import { snippetPreviewColor, snippetPreviewSpans } from './snippet-preview-colors';

export interface InsertSnippetDialogState {
  id: number;
  open: boolean;
  status: 'loading' | 'ready' | 'failed';
  snippets: readonly EditorSnippet[];
}

export function InsertSnippetDialog({
  state,
  colors,
  onClose,
  onInsert,
}: {
  state: InsertSnippetDialogState;
  colors: EditorColorHalf;
  onClose(): void;
  onInsert(snippet: EditorSnippet): void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement | null>(null);
  const options = useRef(new Map<string, HTMLDivElement>());
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;

  useEffect(() => {
    setQuery('');
    setShowAll(false);
    setActiveId(null);
  }, [state.id]);

  const shown = useMemo(
    () => (state.status === 'ready' ? visibleSnippets(state.snippets, query, showAll) : []),
    [query, showAll, state.snippets, state.status],
  );
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

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) onInsert(active);
      return;
    }
    const next = snippetListIndexAfterKey(event.key, activeIndex, shown.length);
    if (next === null) return;
    event.preventDefault();
    setActiveId(shown[next]?.id ?? null);
  };

  const sections = active ? snippetSectionHeaders(active) : [];
  const previewLines = useMemo(
    () => (active ? snippetPreviewSpans(active.preview, active.previewTokens) : []),
    [active],
  );
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={state.open}
    >
      <DialogContent
        className="insert-snippet-dialog"
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
            {shown.map((snippet, index) => {
              const selected = snippet === active;
              return (
                <div
                  aria-selected={selected}
                  className="insert-snippet-option"
                  data-active={selected || undefined}
                  data-snippet-id={snippet.id}
                  id={optionId(index)}
                  key={snippet.id}
                  onClick={() => onInsert(snippet)}
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
                  <span className="insert-snippet-option-label">{snippet.label}</span>
                  <span className="insert-snippet-option-summary">{snippet.summary}</span>
                </div>
              );
            })}
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
        <div className="insert-snippet-actions">
          <DialogClose variant="secondary">{t('code-editor.snippets.cancel')}</DialogClose>
          <Button disabled={!active} onClick={() => active && onInsert(active)}>
            {t('code-editor.snippets.insert')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
