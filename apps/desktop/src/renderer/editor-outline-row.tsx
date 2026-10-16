import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { MessageId } from '../shared/i18n/translator';
import { useI18n } from './i18n';
import { OverflowingLabel } from './overflow-label';
import {
  outlineLevels,
  outlineMenuWindow,
  type DocumentOutline,
  type OutlineEntry,
  type OutlineLevel,
  type OutlineLevelKind,
} from './editor-outline';

const levelNames: Record<OutlineLevelKind, MessageId> = {
  section: 'code-editor.outline.go-to-section',
  block: 'code-editor.outline.go-to-block',
  function: 'code-editor.outline.go-to-function',
};

export function EditorOutlineRow({
  outline,
  path,
  onChoose,
  focusEditor,
}: {
  outline: DocumentOutline;
  path: readonly OutlineEntry[];
  onChoose(entry: OutlineEntry): void;
  focusEditor(): void;
}) {
  const { t } = useI18n();
  const levels = outlineLevels(outline, path);
  if (levels.length === 0) {
    return (
      <div className="editor-outline-row" data-empty="true" data-testid="editor-outline-row" />
    );
  }
  const deepest = path.at(-1) ?? null;
  return (
    <nav
      aria-label={t('code-editor.outline.label')}
      className="editor-outline-row"
      data-testid="editor-outline-row"
    >
      <ol className="editor-outline-parts">
        {levels.map((level, index) => (
          <li className="editor-outline-item" data-part={level.kind} key={index}>
            <OutlinePart
              deepest={level.current !== null && level.current === deepest}
              focusEditor={focusEditor}
              level={level}
              onChoose={onChoose}
            />
          </li>
        ))}
      </ol>
    </nav>
  );
}

function OutlinePart({
  deepest,
  focusEditor,
  level,
  onChoose,
}: {
  deepest: boolean;
  focusEditor(): void;
  level: OutlineLevel;
  onChoose(entry: OutlineEntry): void;
}) {
  const { t } = useI18n();
  const { current, entries } = level;
  const [open, setOpen] = useState(false);
  const chosen = useRef(false);
  const currentItem = useRef<HTMLDivElement | null>(null);
  const shown = open ? outlineMenuWindow(entries, current) : [];

  useEffect(() => {
    if (!open) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const item = currentItem.current;
      if (!item) return;
      item.scrollIntoView({ block: 'nearest' });
      item.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(next) => {
        if (next) chosen.current = false;
        setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next && chosen.current) focusEditor();
      }}
      open={open}
    >
      <DropdownMenuTrigger
        render={
          <Button
            aria-current={deepest ? 'location' : undefined}
            aria-label={current ? undefined : t(levelNames[level.kind])}
            className="editor-outline-part"
            data-deepest={deepest || undefined}
            data-empty={current ? undefined : 'true'}
            size="sm"
            type="button"
            variant="ghost"
          />
        }
      >
        <ChevronRight aria-hidden="true" className="editor-outline-chevron" />
        {current ? (
          <OverflowingLabel
            className="editor-outline-part-label"
            hoverArea=".editor-outline-part"
            name={current.label}
            revealOnParentFocus
            textClassName="editor-outline-part-label-text"
          />
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="editor-outline-menu"
        finalFocus={() => !chosen.current}
        side="top"
      >
        {shown.map((entry, index) => {
          const isCurrent = entry === current;
          const focusTarget = isCurrent || (current === null && index === 0);
          return (
            <DropdownMenuItem
              aria-current={isCurrent ? 'location' : undefined}
              aria-label={t('code-editor.outline.item', {
                label: entry.label,
                line: entry.line + 1,
              })}
              className="editor-outline-menu-item"
              data-current={isCurrent || undefined}
              key={`${entry.line}:${entry.character}:${entry.label}`}
              label={entry.label}
              onClick={() => {
                chosen.current = true;
                onChoose(entry);
              }}
              ref={focusTarget ? currentItem : undefined}
            >
              <span className="editor-outline-menu-label">{entry.label}</span>
              <span aria-hidden="true" className="editor-outline-menu-line">
                {entry.line + 1}
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
