import * as React from 'react';
import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SnippetFileError,
  anySnippetSection,
  isOwnSnippetSection,
  ownSnippetLimits,
  ownSnippetNameProblem,
  saveOwnSnippet,
  snippetSections,
  type OwnSnippet,
  type OwnSnippetSection,
} from '../shared/own-snippets';
import type { MessageId } from '../shared/i18n/translator';
import { useI18n } from './i18n';
import { SnippetCodeEditor } from './snippet-code-editor';
import { sectionHeader } from './snippet-placement';

export interface SaveSnippetDialogState {
  id: number;
  open: boolean;
  previousName: string | null;
  initial: OwnSnippet;
  existing: readonly OwnSnippet[];
}

type Problem =
  | 'name-required'
  | 'name-taken'
  | 'name-invalid'
  | 'code-required'
  | 'code-too-long'
  | 'too-many'
  | 'too-large'
  | 'failed';

const problemWords: Readonly<Record<Problem, MessageId>> = {
  'name-required': 'code-editor.save-snippet.problem.name-required',
  'name-taken': 'code-editor.save-snippet.problem.name-taken',
  'name-invalid': 'code-editor.save-snippet.problem.name-invalid',
  'code-required': 'code-editor.save-snippet.problem.code-required',
  'code-too-long': 'code-editor.save-snippet.problem.code-too-long',
  'too-many': 'code-editor.save-snippet.problem.too-many',
  'too-large': 'code-editor.save-snippet.problem.too-large',
  failed: 'code-editor.save-snippet.problem.failed',
};

export function SaveSnippetDialog({
  state,
  nested = false,
  finalFocus,
  onClose,
  onSaved,
}: {
  state: SaveSnippetDialogState;
  nested?: boolean;
  finalFocus?: React.RefObject<HTMLElement | null>;
  onClose(): void;
  onSaved(snippets: OwnSnippet[], saved: OwnSnippet): void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(state.initial.name);
  const [section, setSection] = useState<OwnSnippetSection>(state.initial.section);
  const [description, setDescription] = useState(state.initial.description);
  const [body, setBody] = useState(state.initial.body);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement | null>(null);
  const ids = useId();
  const field = (part: string) => `${ids}-${part}`;

  useEffect(() => {
    setName(state.initial.name);
    setSection(state.initial.section);
    setDescription(state.initial.description);
    setBody(state.initial.body);
    setProblem(null);
    setSaving(false);
  }, [state.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const nameProblem = problem?.startsWith('name-') ? problem : null;
  const codeProblem = problem?.startsWith('code-') ? problem : null;
  const saveProblem = problem && !nameProblem && !codeProblem ? problem : null;

  const save = async () => {
    if (saving) return;
    const nameCheck = ownSnippetNameProblem(name, state.existing, state.previousName);
    if (nameCheck === 'required') return void setProblem('name-required');
    if (nameCheck === 'taken') return void setProblem('name-taken');
    if (nameCheck) return void setProblem('name-invalid');
    if (!body.trim()) return void setProblem('code-required');
    if (body.length > ownSnippetLimits.body) return void setProblem('code-too-long');
    const snippet: OwnSnippet = { name: name.trim(), section, description, body };
    try {
      saveOwnSnippet(state.existing, snippet, state.previousName);
    } catch (error) {
      const reason = error instanceof SnippetFileError ? error.reason : null;
      return void setProblem(
        reason === 'too-many' ? 'too-many' : reason === 'too-large' ? 'too-large' : 'failed',
      );
    }
    setSaving(true);
    try {
      const snippets = await window.rmside.saveOwnSnippet(snippet, state.previousName);
      const saved = snippets.find((entry) => entry.name === snippet.name) ?? snippet;
      onSaved(snippets, saved);
    } catch {
      setProblem('failed');
      setSaving(false);
    }
  };

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={state.open}
    >
      {nested ? (
        <DialogPortal>
          <DialogOverlay className="save-snippet-nested-backdrop" forceRender />
        </DialogPortal>
      ) : null}
      <DialogContent
        className="save-snippet-dialog"
        data-testid="save-snippet-dialog"
        {...(finalFocus ? { finalFocus } : {})}
        initialFocus={nameInput}
      >
        <DialogClose
          aria-label={t('code-editor.save-snippet.close')}
          className="save-snippet-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>
            {t(
              state.previousName === null
                ? 'code-editor.save-snippet.title'
                : 'code-editor.save-snippet.title.edit',
            )}
          </DialogTitle>
        </DialogHeader>
        <form
          className="save-snippet-fields"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="save-snippet-field">
            <label htmlFor={field('name')}>{t('code-editor.save-snippet.name')}</label>
            <Input
              aria-describedby={nameProblem ? field('name-problem') : undefined}
              aria-invalid={nameProblem !== null || undefined}
              autoComplete="off"
              id={field('name')}
              maxLength={ownSnippetLimits.name}
              onChange={(event) => {
                setName(event.target.value);
                setProblem(null);
              }}
              ref={nameInput}
              spellCheck={false}
              value={name}
            />
            {nameProblem ? (
              <p className="save-snippet-problem" id={field('name-problem')}>
                {t(problemWords[nameProblem])}
              </p>
            ) : null}
          </div>
          <div className="save-snippet-field">
            <span id={field('section-label')}>{t('code-editor.save-snippet.section')}</span>
            <Select
              onValueChange={(value) => {
                if (isOwnSnippetSection(value)) setSection(value);
              }}
              value={section}
            >
              <SelectTrigger
                aria-labelledby={field('section-label')}
                className="save-snippet-section"
                data-testid="save-snippet-section"
              >
                <SelectValue>
                  {section === anySnippetSection ? (
                    t('code-editor.save-snippet.section.any')
                  ) : (
                    <code dir="ltr">{sectionHeader(section)}</code>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="save-snippet-section-menu">
                <SelectItem value={anySnippetSection}>
                  {t('code-editor.save-snippet.section.any')}
                </SelectItem>
                {snippetSections.map((entry) => (
                  <SelectItem key={entry} value={entry}>
                    <code dir="ltr">{sectionHeader(entry)}</code>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="save-snippet-field">
            <label htmlFor={field('description')}>
              {t('code-editor.save-snippet.description')}
            </label>
            <Input
              autoComplete="off"
              id={field('description')}
              maxLength={ownSnippetLimits.description}
              onChange={(event) => {
                setDescription(event.target.value);
                setProblem(null);
              }}
              placeholder={t('code-editor.save-snippet.description.placeholder')}
              value={description}
            />
          </div>
          <div className="save-snippet-field save-snippet-code-field">
            <span id={field('code-label')}>{t('code-editor.save-snippet.code')}</span>
            <SnippetCodeEditor
              describedBy={codeProblem ? field('code-problem') : undefined}
              initialValue={state.initial.body}
              invalid={codeProblem !== null}
              key={state.id}
              label={t('code-editor.save-snippet.code')}
              labelId={field('code-label')}
              onChange={(value) => {
                setBody(value);
                setProblem(null);
              }}
              onEscape={onClose}
              section={section}
            />
            {codeProblem ? (
              <p className="save-snippet-problem" id={field('code-problem')}>
                {t(problemWords[codeProblem])}
              </p>
            ) : null}
          </div>
          {saveProblem ? (
            <p className="save-snippet-problem save-snippet-save-problem" role="alert">
              {t(problemWords[saveProblem])}
            </p>
          ) : null}
          <div className="save-snippet-actions">
            <DialogClose variant="secondary">{t('code-editor.save-snippet.cancel')}</DialogClose>
            <Button disabled={saving} type="submit">
              {t('code-editor.save-snippet.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
