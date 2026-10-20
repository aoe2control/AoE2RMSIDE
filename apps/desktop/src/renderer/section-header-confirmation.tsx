import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import * as monaco from 'monaco-editor';
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
import { useI18n } from './i18n';
import { parseSnippetContext, type DocumentSection } from './insert-snippet';
import { onSectionHeaderAccepted, requestRmsSnippets } from './monaco-language';
import {
  sectionHeader,
  sectionHeaderPlacement,
  sectionOfHeader,
  sectionsWithoutHeader,
  snippetEdit,
  type SectionHeaderPlacement,
} from './snippet-placement';
import type { SnippetSection } from '../shared/own-snippets';

interface AcceptedHeader {
  model: monaco.editor.ITextModel;
  version: number;
  lineNumber: number;
  before: string;
  after: string;
  lineCount: number;
  section: SnippetSection;
  placement: Exclude<SectionHeaderPlacement, { kind: 'fine' }>;
  sections: DocumentSection[];
}

type Choice = 'cancel' | 'here' | 'go' | 'move';

interface ConfirmationState {
  id: number;
  open: boolean;
  kind: 'present' | 'misplaced';
  header: string;
}

export function SectionHeaderConfirmation({
  editor,
}: {
  editor: RefObject<monaco.editor.IStandaloneCodeEditor | null>;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<ConfirmationState>({
    id: 0,
    open: false,
    kind: 'present',
    header: '',
  });
  const accepted = useRef<AcceptedHeader | null>(null);
  const sequence = useRef(0);
  const primary = useRef<HTMLButtonElement | null>(null);

  const check = useCallback(
    async (uri: string, header: string) => {
      const instance = editor.current;
      const model = instance?.getModel();
      const position = instance?.getPosition();
      const section = sectionOfHeader(header);
      if (!instance || !model || !position || !section) return;
      if (model.uri.toString() !== uri || model.getLanguageId() !== 'rms') return;
      const line = model.getLineContent(position.lineNumber);
      const end = position.column - 1;
      const start = end - header.length;
      if (start < 0 || line.slice(start, end) !== header) return;
      const id = ++sequence.current;
      const version = model.getAlternativeVersionId();
      let sections: DocumentSection[];
      try {
        sections = parseSnippetContext(await requestRmsSnippets(model, position), 0).sections;
      } catch {
        return;
      }
      if (
        sequence.current !== id ||
        model.isDisposed() ||
        editor.current?.getModel() !== model ||
        model.getAlternativeVersionId() !== version
      ) {
        return;
      }
      const placement = sectionHeaderPlacement(section, position.lineNumber - 1, sections);
      if (placement.kind === 'fine') return;
      accepted.current = {
        model,
        version,
        lineNumber: position.lineNumber,
        before: line.slice(0, start),
        after: line.slice(end),
        lineCount: model.getLineCount(),
        section,
        placement,
        sections,
      };
      setState((current) => ({
        id: current.id + 1,
        open: true,
        kind: placement.kind,
        header: sectionHeader(section),
      }));
    },
    [editor],
  );

  useEffect(
    () =>
      onSectionHeaderAccepted((uri, header) => {
        void check(uri, header);
      }),
    [check],
  );

  const finish = useCallback(
    async (choice: Choice) => {
      const target = accepted.current;
      accepted.current = null;
      setState((current) => (current.open ? { ...current, open: false } : current));
      const instance = editor.current;
      if (!target || !instance || choice === 'here') return;
      const { model } = target;
      if (
        model.isDisposed() ||
        instance.getModel() !== model ||
        model.getAlternativeVersionId() !== target.version
      ) {
        return;
      }
      const typed = await undoAcceptance(target);
      if (typed === null || choice === 'cancel') return;
      const typedRange = new monaco.Range(
        target.lineNumber,
        target.before.length + 1,
        target.lineNumber,
        target.before.length + 1 + typed.length,
      );
      instance.pushUndoStop();
      if (typed) instance.executeEdits('rmside.section-header', [{ range: typedRange, text: '' }]);
      if (choice === 'go' && target.placement.kind === 'present') {
        instance.pushUndoStop();
        const position = headerPosition(model, target.placement.existing.header, target.section);
        instance.setPosition(position, 'rmside.section-header');
        instance.revealPositionInCenter(position);
        return;
      }
      const lines = model.getLinesContent();
      lines[target.lineNumber - 1] = `${target.before}${target.after}`;
      const edit = snippetEdit(
        lines,
        sectionsWithoutHeader(target.section, target.lineNumber - 1, target.sections),
        target.section,
        'create-section',
        '',
      );
      const place = model.validatePosition({ lineNumber: edit.lineNumber, column: edit.column });
      instance.setSelection(
        new monaco.Selection(place.lineNumber, place.column, place.lineNumber, place.column),
      );
      const controller = instance.getContribution('snippetController2') as unknown as {
        insert(
          template: string,
          options?: { undoStopBefore?: boolean; undoStopAfter?: boolean },
        ): void;
      } | null;
      controller?.insert(edit.template, { undoStopBefore: false, undoStopAfter: true });
      const selection = instance.getSelection();
      if (selection) instance.revealRangeInCenterIfOutsideViewport(selection);
    },
    [editor],
  );

  useEffect(() => {
    if (state.open || state.id === 0) return;
    editor.current?.focus();
  }, [editor, state.id, state.open]);

  const present = state.kind === 'present';
  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) void finish('cancel');
      }}
      open={state.open}
    >
      <AlertDialogContent
        data-testid="section-header-confirmation"
        finalFocus={false}
        initialFocus={primary}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {present
              ? t('code-editor.section-header.present.title', { section: state.header })
              : t('code-editor.section-header.misplaced.title', { section: state.header })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {present
              ? t('code-editor.section-header.present.description', { section: state.header })
              : t('code-editor.section-header.misplaced.description', {
                  section: state.header,
                })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('code-editor.section-header.cancel')}</AlertDialogCancel>
          <Button onClick={() => void finish('here')} variant="secondary">
            {t('code-editor.section-header.here')}
          </Button>
          <AlertDialogAction onClick={() => void finish(present ? 'go' : 'move')} ref={primary}>
            {present
              ? t('code-editor.section-header.present.confirm')
              : t('code-editor.section-header.misplaced.confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

async function undoAcceptance(target: AcceptedHeader): Promise<string | null> {
  const { model } = target;
  await model.undo();
  const text =
    model.getLineCount() === target.lineCount ? model.getLineContent(target.lineNumber) : '';
  if (
    model.getAlternativeVersionId() !== target.version &&
    model.getLineCount() === target.lineCount &&
    text.length >= target.before.length + target.after.length &&
    text.startsWith(target.before) &&
    text.endsWith(target.after)
  ) {
    return text.slice(target.before.length, text.length - target.after.length);
  }
  if (model.getAlternativeVersionId() !== target.version) await model.redo();
  return null;
}

function headerPosition(
  model: monaco.editor.ITextModel,
  line: number,
  section: SnippetSection,
): monaco.Position {
  const lineNumber = Math.min(Math.max(1, line + 1), model.getLineCount());
  const text = model.getLineContent(lineNumber);
  const header = sectionHeader(section);
  const index = text.toUpperCase().indexOf(header);
  const column =
    index >= 0 ? index + header.length + 1 : model.getLineFirstNonWhitespaceColumn(lineNumber) || 1;
  return new monaco.Position(lineNumber, column);
}
