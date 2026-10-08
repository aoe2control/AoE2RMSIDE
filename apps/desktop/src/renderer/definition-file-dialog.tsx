import { useEffect, useMemo, useRef, useState } from 'react';
import { FileDigit, X } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { ToggleButton } from '@/components/ui/toggle-button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { DefinitionFilePlan } from '../shared/api';
import {
  definitionFileKey,
  definitionFileNameProblem,
  definitionGroupCount,
  definitionGroupIds,
  resolveDefinitionNames,
  suggestedDefinitionFileName,
  type DefinitionGroupId,
  type ResolvedDefinitions,
} from '../shared/definition-file';
import type { MessageId } from '../shared/i18n/translator';
import { presentMessage } from '../shared/message-catalog';
import type { OutputMessage } from '../shared/output-message';
import { useI18n } from './i18n';
import { OverflowingLabel } from './overflow-label';

export interface DefinitionFileRequest {
  key: number;
  folderId: string | null;
}

const groupWords: Readonly<Record<DefinitionGroupId, { name: MessageId; description: MessageId }>> =
  Object.freeze({
    terrains: {
      name: 'definition-file.group.terrains',
      description: 'definition-file.group.terrains.description',
    },
    objects: {
      name: 'definition-file.group.objects',
      description: 'definition-file.group.objects.description',
    },
  });

const fileNameProblemWords: Readonly<Record<string, MessageId>> = Object.freeze({
  empty: 'definition-file.file-name.empty',
  invalid: 'definition-file.file-name.invalid',
  extension: 'definition-file.file-name.extension',
  reserved: 'definition-file.file-name.reserved',
});

function effectiveGroups(
  chosen: ReadonlySet<DefinitionGroupId>,
  resolved: ResolvedDefinitions,
  includeBuiltIn: boolean,
): DefinitionGroupId[] {
  return definitionGroupIds.filter(
    (group) => chosen.has(group) && definitionGroupCount(resolved, group, includeBuiltIn) > 0,
  );
}

function excludedFileFor(plan: DefinitionFilePlan, fileName: string): string | null {
  if (plan.target.kind !== 'folder') return null;
  return definitionFileKey(
    plan.target.relativePath ? `${plan.target.relativePath}/${fileName}` : fileName,
  );
}

export function DefinitionFileDialog({
  request,
  onClose,
  onWritten,
  onFailure,
}: {
  request: DefinitionFileRequest | null;
  onClose(): void;
  onWritten(path: string): void;
  onFailure(message: OutputMessage): void;
}) {
  const { t } = useI18n();
  const [plan, setPlan] = useState<DefinitionFilePlan | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [chosen, setChosen] = useState<ReadonlySet<DefinitionGroupId>>(
    () => new Set(definitionGroupIds),
  );
  const [includeBuiltIn, setIncludeBuiltIn] = useState(false);
  const [fileName, setFileName] = useState('');
  const [fileNameManaged, setFileNameManaged] = useState(true);
  const [busy, setBusy] = useState(false);
  const [writeFailed, setWriteFailed] = useState(false);
  const [replaceName, setReplaceName] = useState<string | null>(null);
  const fileNameInput = useRef<HTMLInputElement>(null);
  const requestKey = request?.key ?? null;
  const folderId = request?.folderId ?? null;

  useEffect(() => {
    if (requestKey === null) return undefined;
    let cancelled = false;
    setPlan(null);
    setLoadFailed(false);
    setChosen(new Set(definitionGroupIds));
    setIncludeBuiltIn(false);
    setFileName('');
    setFileNameManaged(true);
    setBusy(false);
    setWriteFailed(false);
    setReplaceName(null);
    void window.rmside
      .prepareDefinitionFile({ folderId })
      .then((next) => {
        if (cancelled) return;
        const reserved = new Set(next.reservedFileNames);
        const all = new Set(definitionGroupIds);
        const first = suggestedDefinitionFileName(definitionGroupIds, reserved);
        const resolved = resolveDefinitionNames(
          next.candidates,
          next.project,
          excludedFileFor(next, first),
        );
        const groups = effectiveGroups(all, resolved, false);
        setPlan(next);
        setFileName(
          suggestedDefinitionFileName(groups.length > 0 ? groups : definitionGroupIds, reserved),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadFailed(true);
        onFailure(
          presentMessage({
            source: 'Files',
            raw: error instanceof Error ? error.message : String(error),
            fallbackHeadline: 'definition-file.output.unavailable',
          }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [requestKey, folderId]);

  const reserved = useMemo(() => new Set(plan?.reservedFileNames ?? []), [plan]);
  const resolved = useMemo(
    () =>
      plan
        ? resolveDefinitionNames(plan.candidates, plan.project, excludedFileFor(plan, fileName))
        : null,
    [plan, fileName],
  );
  const groups = resolved ? effectiveGroups(chosen, resolved, includeBuiltIn) : [];
  const ready = plan?.status === 'ready' && resolved !== null;
  const nameProblem = plan ? definitionFileNameProblem(fileName, reserved) : null;

  useEffect(() => {
    if (!plan) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const input = fileNameInput.current;
      if (!input || input.disabled) return;
      input.focus({ focusVisible: false, preventScroll: true });
      input.setSelectionRange(0, input.value.replace(/\.inc$/iu, '').length);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [plan]);

  const applyChoice = (nextChosen: ReadonlySet<DefinitionGroupId>, nextBuiltIn: boolean) => {
    setChosen(nextChosen);
    setIncludeBuiltIn(nextBuiltIn);
    if (!fileNameManaged || !resolved) return;
    const next = effectiveGroups(nextChosen, resolved, nextBuiltIn);
    setFileName(suggestedDefinitionFileName(next.length > 0 ? next : definitionGroupIds, reserved));
  };

  const generate = async (overwrite: boolean) => {
    if (!plan || !ready || groups.length === 0 || nameProblem || busy) return;
    setBusy(true);
    setWriteFailed(false);
    try {
      const result = await window.rmside.generateDefinitionFile({
        planId: plan.planId,
        fileName,
        groups,
        includeBuiltIn,
        overwrite,
      });
      if (result.status === 'exists') {
        setReplaceName(result.fileName);
      } else if (result.status === 'written') {
        setReplaceName(null);
        onWritten(result.path);
        onClose();
      }
    } catch (error) {
      setWriteFailed(true);
      onFailure(
        presentMessage({
          source: 'Files',
          raw: error instanceof Error ? error.message : String(error),
          fallbackHeadline: 'definition-file.output.failed',
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  const chosenGroups = definitionGroupIds.filter((group) => chosen.has(group));
  const leftOutByProject =
    resolved && includeBuiltIn
      ? chosenGroups.reduce((total, group) => total + resolved[group].definedInProject, 0)
      : 0;
  const leftOutWithoutName = resolved
    ? chosenGroups.reduce((total, group) => total + resolved[group].withoutUniqueName, 0)
    : 0;
  const nothingWithoutBuiltIn =
    resolved !== null &&
    definitionGroupIds.every((group) => definitionGroupCount(resolved, group, false) === 0);
  const notes: string[] = [];
  if (plan && ready) {
    if (!plan.projectComplete) notes.push(t('definition-file.note.project-partial'));
    if (plan.gameFolderNames === 'no-game-folder')
      notes.push(t('definition-file.note.no-game-folder'));
    else if (plan.gameFolderNames === 'other-version') {
      notes.push(t('definition-file.note.other-version'));
    } else if (plan.gameFolderNames === 'no-text') notes.push(t('definition-file.note.no-text'));
    else if (nothingWithoutBuiltIn) notes.push(t('definition-file.note.nothing-new'));
    if (leftOutByProject > 0) {
      notes.push(t('definition-file.note.left-out.project', { count: leftOutByProject }));
    }
    if (leftOutWithoutName > 0) {
      notes.push(t('definition-file.note.left-out.unique', { count: leftOutWithoutName }));
    }
  }
  const identities = plan?.identities ?? null;
  const targetName =
    plan?.target.kind === 'folder' ? plan.target.name : t('definition-file.target.save-dialog');
  const shownTarget =
    folderId !== null || !plan
      ? null
      : plan.target.kind === 'folder'
        ? `${plan.target.name}/`
        : t('definition-file.target.save-dialog');

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      open={request !== null}
    >
      <DialogContent className="definition-file-dialog" initialFocus={fileNameInput}>
        <DialogClose
          aria-label={t('definition-file.close-label')}
          className="definition-file-close"
          size="icon-compact"
          variant="ghost"
        >
          <X aria-hidden="true" />
        </DialogClose>
        <DialogHeader>
          <DialogTitle>
            <FileDigit aria-hidden="true" /> {t('definition-file.title')}
          </DialogTitle>
        </DialogHeader>
        <form
          className="definition-file-body owned-scrollbars"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void generate(false);
          }}
        >
          {plan === null ? (
            <p className="definition-file-status" role="status">
              {loadFailed ? t('definition-file.unavailable.failed') : t('definition-file.loading')}
            </p>
          ) : (
            <>
              {identities ? (
                <div className="definition-file-fields">
                  <div className="definition-file-field" data-testid="definition-file-game-version">
                    <span>{t('definition-file.identity.game-version')}</span>
                    <span className="definition-file-value">
                      {identities.gameVersionVerified
                        ? identities.gameVersion
                        : t('definition-file.identity.game-version.unverified', {
                            version: identities.gameVersion,
                          })}
                    </span>
                  </div>
                  {shownTarget !== null ? (
                    <div className="definition-file-field" data-testid="definition-file-target">
                      <span>{t('definition-file.identity.target')}</span>
                      <span className="definition-file-value">{shownTarget}</span>
                    </div>
                  ) : null}
                  {ready ? (
                    <div className="definition-file-field">
                      <label htmlFor="definition-file-name">
                        {t('definition-file.file-name.label')}
                      </label>
                      <Input
                        aria-describedby={nameProblem ? 'definition-file-name-problem' : undefined}
                        aria-invalid={nameProblem !== null || undefined}
                        autoComplete="off"
                        disabled={busy}
                        id="definition-file-name"
                        onChange={(event) => {
                          setFileNameManaged(false);
                          setFileName(event.target.value);
                          setWriteFailed(false);
                        }}
                        ref={fileNameInput}
                        spellCheck={false}
                        value={fileName}
                      />
                      {nameProblem ? (
                        <p className="definition-file-problem" id="definition-file-name-problem">
                          {t(fileNameProblemWords[nameProblem]!)}
                        </p>
                      ) : writeFailed ? (
                        <p className="definition-file-problem" role="alert">
                          {t('definition-file.error')}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {!ready ? (
                <p className="definition-file-status" role="status">
                  {identities
                    ? t('definition-file.unavailable.incomplete')
                    : t('definition-file.unavailable.no-content')}
                </p>
              ) : (
                <>
                  <div
                    aria-label={t('definition-file.groups.label')}
                    className="definition-file-options"
                    role="group"
                  >
                    {definitionGroupIds.map((group) => {
                      const count = definitionGroupCount(resolved, group, includeBuiltIn);
                      const available = count > 0;
                      const checked = available && chosen.has(group);
                      return (
                        <ToggleButton
                          checked={checked}
                          className="definition-file-option"
                          data-testid={`definition-file-group-${group}`}
                          disabled={!available || busy}
                          key={group}
                          onClick={() => {
                            const next = new Set(chosen);
                            if (next.has(group)) next.delete(group);
                            else next.add(group);
                            applyChoice(next, includeBuiltIn);
                          }}
                        >
                          <span className="definition-file-option-text">
                            <span className="definition-file-option-name">
                              {t(groupWords[group].name)}
                            </span>
                            <span className="definition-file-option-description">
                              {t(groupWords[group].description)}
                            </span>
                          </span>
                          <span className="definition-file-option-count">
                            {t('definition-file.group.count', { count })}
                          </span>
                        </ToggleButton>
                      );
                    })}
                    <ToggleButton
                      checked={includeBuiltIn}
                      className="definition-file-option"
                      data-testid="definition-file-built-in"
                      disabled={busy}
                      onClick={() => applyChoice(chosen, !includeBuiltIn)}
                    >
                      <span className="definition-file-option-text">
                        <span className="definition-file-option-name">
                          {t('definition-file.built-in')}
                        </span>
                        <span className="definition-file-option-description">
                          {t('definition-file.built-in.description')}
                        </span>
                      </span>
                    </ToggleButton>
                  </div>
                </>
              )}
            </>
          )}
          {ready ? (
            <div className="definition-file-actions">
              {notes.length > 0 ? <DefinitionFileNotes notes={notes} /> : null}
              <Button
                data-testid="definition-file-generate"
                disabled={busy || groups.length === 0 || nameProblem !== null}
                type="submit"
              >
                {plan?.target.kind === 'save-dialog'
                  ? t('definition-file.generate.save-dialog')
                  : t('definition-file.generate')}
              </Button>
            </div>
          ) : null}
        </form>
        <AlertDialog
          onOpenChange={(open) => {
            if (!open) setReplaceName(null);
          }}
          open={replaceName !== null}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t('definition-file.replace.title', { name: replaceName ?? fileName })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t('definition-file.replace.description', { folder: targetName })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                data-testid="definition-file-replace"
                onClick={() => {
                  setReplaceName(null);
                  void generate(true);
                }}
                variant="destructive"
              >
                {t('definition-file.replace.confirm')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function DefinitionFileNotes({ notes }: { notes: readonly string[] }) {
  const { t } = useI18n();
  const shown = notes[0] ?? '';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="definition-file-notes"
            data-testid="definition-file-notes"
            role="note"
            tabIndex={0}
          />
        }
      >
        <span aria-hidden="true" className="definition-file-notes-shown">
          <OverflowingLabel
            className="definition-file-note"
            name={shown}
            textClassName="definition-file-note-text"
          />
          {notes.length > 1 ? (
            <span className="definition-file-notes-more" data-testid="definition-file-notes-more">
              {t('definition-file.notes.more', { count: notes.length - 1 })}
            </span>
          ) : null}
        </span>
        {notes.map((note) => (
          <span className="sr-only" key={note}>
            {note}
          </span>
        ))}
      </TooltipTrigger>
      <TooltipContent className="definition-file-notes-tooltip">
        {notes.map((note) => (
          <p key={note}>{note}</p>
        ))}
      </TooltipContent>
    </Tooltip>
  );
}
