import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { History, Map as MapIcon, X } from 'lucide-react';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
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
import type { InstallationReport, PreviewGenerationResult } from '../shared/api';
import { presentDeploymentFailure, presentMessage } from '../shared/message-catalog';
import {
  outputMessageText,
  outputNote,
  wordOutputText,
  wordOutputWords,
  type OutputWords,
} from '../shared/output-message';
import {
  scenarioDeploymentContract,
  scenarioDeploymentMap,
  scenarioNameProblem,
  scenarioSummary,
  suggestedScenarioName,
  type ScenarioDeploymentContext,
  type ScenarioDeploymentRequest,
} from '../shared/scenario-deployment';
import { useAppPanelContext } from './app-context';
import {
  isUsableInstallation,
  pickGameInstallation,
  refusedGameFolderText,
} from './game-installation';
import { useI18n } from './i18n';
import {
  CopyPathField,
  errorMessage,
  ManagedModTreeSkeleton,
  OpenFolderButton,
  preferredSource,
} from './managed-mod-deployment-panel';
import {
  deploymentSourceFailureMessage,
  deploymentSourceFailureOutput,
  deploymentSourceGuidance,
  pendingSourceRunSettlement,
} from './managed-mod-deployment-state';
import { civilizationName } from './packed-game-options';
import { isPreviewScriptName, type PinnedPreviewSource } from './preview-execution';
import { SelectGameFolderButton } from './select-game-folder-button';

const nameHistoryKey = 'rmside.scenario-names.v1';
const nameHistoryLength = 10;

interface PendingSourceRun {
  baselineSequence: number;
  uri: string;
  started: boolean;
}

type ScenarioProblem =
  | { kind: 'deployment'; raw: string }
  | { kind: 'refused-folder'; report: InstallationReport }
  | { kind: 'source-failed'; detail: string }
  | { kind: 'source-cancelled' }
  | { kind: 'unavailable' }
  | { kind: 'text'; text: OutputWords };

interface NameField {
  value: string;
  edited: boolean;
}

function readNameHistory(): string[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(nameHistoryKey) ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(
          (name): name is string => typeof name === 'string' && scenarioNameProblem(name) === null,
        )
      : [];
  } catch {
    return [];
  }
}

function rememberName(name: string): string[] {
  const next = [
    name,
    ...readNameHistory().filter((entry) => entry.toLowerCase() !== name.toLowerCase()),
  ].slice(0, nameHistoryLength);
  try {
    window.localStorage.setItem(nameHistoryKey, JSON.stringify(next));
  } catch {}
  return next;
}

export function ScenarioDeploymentPanel({
  onOpenChange,
  open,
}: {
  onOpenChange(open: boolean): void;
  open: boolean;
}) {
  const { appendOutput, map, pinnedPreviewSource, previewExecution, workspace } =
    useAppPanelContext();
  const { t } = useI18n();
  const sources = useMemo<PinnedPreviewSource[]>(
    () =>
      workspace.documents
        .filter((document) => isPreviewScriptName(document.name))
        .map(({ id, uri, name, content }) => ({ id, uri, name, content })),
    [workspace.documents],
  );
  const [selectedSourceId, setSelectedSourceId] = useState('');
  const selectedSource = sources.find((source) => source.id === selectedSourceId) ?? null;
  const [refreshSequence, setRefreshSequence] = useState(0);
  const [pendingSourceRun, setPendingSourceRun] = useState<PendingSourceRun | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [exactResult, setExactResult] = useState<PreviewGenerationResult | null>(null);
  const [context, setContext] = useState<ScenarioDeploymentContext | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [profileId, setProfileId] = useState('');
  const [nameField, setNameField] = useState<NameField>({ value: '', edited: false });
  const [nameHistory, setNameHistory] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);
  const [problem, setProblem] = useState<ScenarioProblem | null>(null);
  const [effectsPrompt, setEffectsPrompt] = useState(false);
  const [replacePrompt, setReplacePrompt] = useState<ScenarioDeploymentRequest | null>(null);
  const [success, setSuccess] = useState<{ path: string } | null>(null);
  const [openTargetBusy, setOpenTargetBusy] = useState(false);
  const [openFolderBusy, setOpenFolderBusy] = useState(false);
  const finishButton = useRef<HTMLButtonElement>(null);
  const initializedOpen = useRef(false);
  const attemptedRefresh = useRef('');
  const contextSequence = useRef(0);
  const installationRequired = contextLoaded && context === null;
  const scenarioMap = useMemo(
    () => (exactResult ? scenarioDeploymentMap(exactResult) : null),
    [exactResult],
  );
  const name = nameField.value;
  const nameProblem = name ? scenarioNameProblem(name) : null;

  const resetForSource = useCallback((hasSource = true) => {
    setPendingSourceRun(null);
    setSourceLoading(hasSource);
    setExactResult(null);
    setProblem(null);
    setRefreshSequence((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!open) {
      initializedOpen.current = false;
      attemptedRefresh.current = '';
      contextSequence.current += 1;
      setPendingSourceRun(null);
      setSourceLoading(false);
      setExactResult(null);
      setContext(null);
      setContextLoaded(false);
      setProblem(null);
      setEffectsPrompt(false);
      setReplacePrompt(null);
      setNameField({ value: '', edited: false });
      return;
    }
    if (initializedOpen.current) return;
    initializedOpen.current = true;
    setNameHistory(readNameHistory());
    const initial = preferredSource(
      sources,
      pinnedPreviewSource?.id ?? null,
      workspace.activeDocumentId,
    );
    setSelectedSourceId(initial?.id ?? '');
    setSourceLoading(Boolean(initial));
    setRefreshSequence((current) => current + 1);
  }, [open, pinnedPreviewSource?.id, sources, workspace.activeDocumentId]);

  useEffect(() => {
    if (!open || refreshSequence < 1) return;
    const sequence = ++contextSequence.current;
    setContextLoaded(false);
    void window.rmside
      .getScenarioDeploymentContext()
      .then((next) => {
        if (sequence !== contextSequence.current) return;
        setContext(next);
        setContextLoaded(true);
        setProfileId((current) =>
          next?.profiles.some((profile) => profile.profileId === current)
            ? current
            : (next?.selectedProfileId ?? ''),
        );
      })
      .catch((loadError: unknown) => {
        if (sequence !== contextSequence.current) return;
        setContext(null);
        setContextLoaded(true);
        setProblem({ kind: 'deployment', raw: errorMessage(loadError) });
      });
  }, [open, refreshSequence]);

  useEffect(() => {
    if (
      !open ||
      !selectedSource ||
      !previewExecution ||
      refreshSequence < 1 ||
      installationRequired
    )
      return;
    const identity = `${refreshSequence}\0${selectedSource.id}\0${selectedSource.uri}`;
    if (attemptedRefresh.current === identity) return;
    const reusable = previewExecution.reusableCommittedResult?.(selectedSource) ?? null;
    if (reusable && reusable.result === map) {
      attemptedRefresh.current = identity;
      setExactResult(reusable.result);
      setSourceLoading(false);
      return;
    }
    const acceptance = previewExecution.runSource(selectedSource);
    if (acceptance.status === 'blocked') {
      if (acceptance.retryable) return;
      attemptedRefresh.current = identity;
      setSourceLoading(false);
      setProblem({ kind: 'text', text: acceptance.reason });
      return;
    }
    attemptedRefresh.current = identity;
    setPendingSourceRun({
      baselineSequence: previewExecution.completedRunSequence,
      uri: selectedSource.uri,
      started: false,
    });
  }, [installationRequired, map, open, previewExecution, refreshSequence, selectedSource]);

  useEffect(() => {
    if (!pendingSourceRun || !previewExecution) return;
    const settlement = pendingSourceRunSettlement({
      started: pendingSourceRun.started,
      runState: previewExecution.runState,
      executionIdle: previewExecution.executionState.phase === 'idle',
      completedSinceScheduled:
        previewExecution.completedRunSequence > pendingSourceRun.baselineSequence,
      committedForSource: map?.documentUri === pendingSourceRun.uri,
    });
    switch (settlement) {
      case 'started':
        setPendingSourceRun((current) => (current ? { ...current, started: true } : current));
        return;
      case 'completed':
        setExactResult(map);
        setPendingSourceRun(null);
        setSourceLoading(false);
        return;
      case 'failed': {
        setPendingSourceRun(null);
        setSourceLoading(false);
        const detail = previewExecution.status?.message ?? '';
        if (detail) appendOutput(deploymentSourceFailureOutput(detail));
        setProblem({ kind: 'source-failed', detail });
        return;
      }
      case 'cancelled':
        setPendingSourceRun(null);
        setSourceLoading(false);
        setProblem({ kind: 'source-cancelled' });
        return;
      default:
        return;
    }
  }, [appendOutput, map, pendingSourceRun, previewExecution]);

  useEffect(() => {
    if (!selectedSource) return;
    const suggestion = suggestedScenarioName(selectedSource.name, exactResult?.presentationSeed);
    setNameField((field) => (field.edited ? field : { value: suggestion, edited: false }));
  }, [exactResult?.presentationSeed, selectedSource]);

  useEffect(() => {
    if (exactResult && !scenarioMap) setProblem({ kind: 'unavailable' });
  }, [exactResult, scenarioMap]);

  const selectGameFolder = async () => {
    setActionBusy(true);
    setProblem(null);
    try {
      const report = await pickGameInstallation();
      if (!report) return;
      if (!isUsableInstallation(report)) {
        setProblem({ kind: 'refused-folder', report });
        return;
      }
      attemptedRefresh.current = '';
      resetForSource(Boolean(selectedSource));
    } catch (selectionError) {
      setProblem({ kind: 'deployment', raw: errorMessage(selectionError) });
    } finally {
      setActionBusy(false);
    }
  };

  const chooseSource = (value: string | null) => {
    const next = value ?? '';
    if (!next || next === selectedSourceId) return;
    attemptedRefresh.current = '';
    setSelectedSourceId(next);
    resetForSource();
  };

  const deploy = async (request: ScenarioDeploymentRequest) => {
    setActionBusy(true);
    setProblem(null);
    try {
      const outcome = await window.rmside.deployScenario(request);
      if (outcome.status === 'exists') {
        setReplacePrompt(request);
        return;
      }
      setReplacePrompt(null);
      setNameHistory(rememberName(request.name));
      appendOutput(
        outputNote('Deploy', 'deploy.scenario-deployed', {
          id: 'scenario-panel.output.deployed',
          args: {
            name: outcome.fileName,
            objects: outcome.objectCount,
            effects: outcome.effectCount,
          },
        }),
      );
      setSuccess({ path: outcome.path });
      onOpenChange(false);
    } catch (deployError) {
      setReplacePrompt(null);
      const raw = errorMessage(deployError);
      setProblem({ kind: 'deployment', raw });
      appendOutput(presentDeploymentFailure(raw, 'scenario-panel.output.failed'));
    } finally {
      setActionBusy(false);
    }
  };

  const request = (includeEffects: boolean): ScenarioDeploymentRequest | null =>
    scenarioMap && selectedSource && profileId && name && !nameProblem
      ? {
          contractVersion: scenarioDeploymentContract,
          profileId,
          name,
          scriptName: selectedSource.name,
          includeEffects,
          replaceExisting: false,
          map: scenarioMap,
        }
      : null;

  const submit = () => {
    if (!scenarioMap) return;
    if (scenarioMap.scenario.scriptEffects.length > 0) {
      setEffectsPrompt(true);
      return;
    }
    const next = request(false);
    if (next) void deploy(next);
  };

  const openTargetDirectory = async () => {
    if (!profileId) return;
    setOpenTargetBusy(true);
    try {
      await window.rmside.openScenarioFolder(profileId);
    } catch (openError) {
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(openError),
          fallbackHeadline: 'deploy-panel.target.open-folder.failed',
        }),
      );
    } finally {
      setOpenTargetBusy(false);
    }
  };

  const openDeployedScenario = async () => {
    setOpenFolderBusy(true);
    try {
      await window.rmside.showDeployedScenario();
    } catch (openError) {
      appendOutput(
        presentMessage({
          source: 'Deploy',
          raw: errorMessage(openError),
          fallbackHeadline: 'deploy-panel.open-folder.failed',
        }),
      );
    } finally {
      setOpenFolderBusy(false);
    }
  };

  const selectedProfile = context?.profiles.find((profile) => profile.profileId === profileId);
  const loading = sourceLoading || pendingSourceRun !== null || !contextLoaded;
  const summary = scenarioMap ? scenarioSummary(scenarioMap) : null;
  const players =
    scenarioMap?.playerCivilizationIds
      ?.map((civilizationId, slot) => ({ civilizationId, slot }))
      .filter(({ civilizationId, slot }) => slot > 0 && civilizationId >= 0) ?? [];
  const problemText = problem ? scenarioProblemText(problem, t) : null;
  const nameProblemText = nameProblem
    ? nameProblem === 'long'
      ? t('scenario-panel.name.too-long')
      : t('scenario-panel.name.invalid')
    : null;
  const canDeploy = !actionBusy && !loading && request(false) !== null;

  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent
          className="managed-mod-dialog scenario-dialog"
          data-compact={installationRequired || undefined}
        >
          <DialogClose
            aria-label={t('scenario-panel.close')}
            className="managed-mod-close"
            size="icon-compact"
            variant="ghost"
          >
            <X aria-hidden="true" />
          </DialogClose>
          <DialogHeader>
            <DialogTitle>
              <MapIcon aria-hidden="true" /> {t('scenario-panel.title')}
            </DialogTitle>
          </DialogHeader>
          {installationRequired ? (
            <div className="managed-mod-prerequisite">
              <span>{t('deploy-panel.select-game-folder')}</span>
              <SelectGameFolderButton
                disabled={actionBusy}
                onClick={() => void selectGameFolder()}
              />
            </div>
          ) : (
            <div className="managed-mod-body owned-scrollbars">
              <div className="managed-mod-overview scenario-overview">
                <div className="managed-mod-fields">
                  <label>
                    <span>{t('deploy-panel.source')}</span>
                    <Select onValueChange={chooseSource} value={selectedSourceId || null}>
                      <SelectTrigger aria-label={t('deploy-panel.source')}>
                        <SelectValue placeholder={t('deploy-panel.source.placeholder')}>
                          {selectedSource?.name}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        {sources.map((source) => (
                          <SelectItem key={source.id} value={source.id}>
                            {source.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="managed-mod-field">
                    <label htmlFor="scenario-name">{t('scenario-panel.name')}</label>
                    <div className="managed-mod-name-field">
                      <Input
                        aria-invalid={nameProblemText ? true : undefined}
                        aria-label={t('scenario-panel.name')}
                        autoComplete="off"
                        id="scenario-name"
                        maxLength={100}
                        onChange={(event) => {
                          setProblem(null);
                          setNameField({ value: event.target.value, edited: true });
                        }}
                        value={name}
                      />
                      {nameHistory.length > 0 ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            aria-label={t('scenario-panel.name.history')}
                            className="managed-mod-name-trigger"
                            render={<Button size="icon-compact" type="button" variant="ghost" />}
                          >
                            <History aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="managed-mod-name-menu owned-scrollbars"
                          >
                            {nameHistory.map((entry) => (
                              <DropdownMenuItem
                                className="managed-mod-name-option"
                                key={entry}
                                onClick={() => setNameField({ value: entry, edited: true })}
                              >
                                {entry}
                              </DropdownMenuItem>
                            ))}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </div>
                  <label>
                    <span>{t('deploy-panel.profile')}</span>
                    <Select
                      onValueChange={(value) => {
                        setProfileId(value ?? '');
                        setProblem(null);
                      }}
                      value={profileId || null}
                    >
                      <SelectTrigger aria-label={t('deploy-panel.profile')}>
                        <SelectValue placeholder={t('deploy-panel.profile.placeholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {(context?.profiles ?? []).map((profile) => (
                          <SelectItem key={profile.profileId} value={profile.profileId}>
                            {profile.suggested
                              ? t('deploy-panel.profile.suggested', { profile: profile.profileId })
                              : profile.profileId}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <div className="managed-mod-target">
                    <span>{t('deploy-panel.target')}</span>
                    <div className="managed-mod-target-field">
                      <CopyPathField
                        copiedLabel={t('deploy-panel.target.copied')}
                        copyLabel={t('deploy-panel.target.copy')}
                        inputLabel={t('deploy-panel.target')}
                        placeholder={t('deploy-panel.profile.placeholder')}
                        value={selectedProfile?.targetRoot ?? null}
                      />
                      <OpenFolderButton
                        busy={openTargetBusy}
                        className="managed-mod-target-open"
                        disabled={!profileId}
                        label={t('deploy-panel.target.open-folder')}
                        onOpen={() => void openTargetDirectory()}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className="managed-mod-result">
                <div className="managed-mod-result-content">
                  {loading && !summary ? <ManagedModTreeSkeleton /> : null}
                  {scenarioMap && summary ? (
                    <dl
                      aria-label={t('scenario-panel.summary')}
                      className="scenario-summary owned-scrollbars"
                    >
                      <dt>{t('scenario-panel.summary.map')}</dt>
                      <dd>
                        {t('scenario-panel.summary.map.value', {
                          width: scenarioMap.width,
                          height: scenarioMap.height,
                          seed: scenarioMap.presentationSeed ?? 0,
                        })}
                      </dd>
                      <dt>{t('scenario-panel.summary.players')}</dt>
                      <dd>
                        {players
                          .map(({ civilizationId, slot }) =>
                            t('scenario-panel.summary.player', {
                              slot,
                              civilization: wordOutputText(civilizationName(civilizationId)),
                            }),
                          )
                          .join(', ')}
                      </dd>
                      <dt>{t('scenario-panel.summary.objects')}</dt>
                      <dd>{summary.objects}</dd>
                      <dt>{t('scenario-panel.summary.effects')}</dt>
                      <dd>
                        {summary.effects > 0
                          ? summary.effects
                          : t('scenario-panel.summary.effects.none')}
                      </dd>
                      {summary.xsInclude ? (
                        <>
                          <dt>{t('scenario-panel.summary.xs')}</dt>
                          <dd>{summary.xsInclude}</dd>
                        </>
                      ) : null}
                    </dl>
                  ) : null}
                  {!selectedSource && !loading ? (
                    <p className="managed-mod-state">{t('deploy-panel.no-source')}</p>
                  ) : null}
                  {nameProblemText ? (
                    <p className="managed-mod-error" role="alert">
                      {nameProblemText}
                    </p>
                  ) : null}
                  {problemText ? (
                    <p className="managed-mod-error" role="alert">
                      {problemText}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          {installationRequired && problemText ? (
            <p className="managed-mod-error" role="alert">
              {problemText}
            </p>
          ) : null}
          {!installationRequired ? (
            <div className="managed-mod-actions">
              <Button data-testid="scenario-deploy" disabled={!canDeploy} onClick={submit}>
                {t('scenario-panel.deploy')}
              </Button>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <AlertDialog onOpenChange={(next) => !next && setEffectsPrompt(false)} open={effectsPrompt}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scenario-panel.effects.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scenario-panel.effects.description', {
                count: scenarioMap?.scenario.scriptEffects.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('dialog.confirm.cancel')}</AlertDialogCancel>
            <Button
              onClick={() => {
                setEffectsPrompt(false);
                const next = request(false);
                if (next) void deploy(next);
              }}
              type="button"
              variant="secondary"
            >
              {t('scenario-panel.effects.leave')}
            </Button>
            <AlertDialogAction
              onClick={() => {
                setEffectsPrompt(false);
                const next = request(true);
                if (next) void deploy(next);
              }}
            >
              {t('scenario-panel.effects.triggers')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        onOpenChange={(next) => !next && setReplacePrompt(null)}
        open={replacePrompt !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scenario-panel.replace.title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('scenario-panel.replace.description', { name: replacePrompt?.name ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={actionBusy}>
              {t('dialog.confirm.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={actionBusy}
              onClick={() =>
                replacePrompt && void deploy({ ...replacePrompt, replaceExisting: true })
              }
            >
              {t('scenario-panel.replace.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog onOpenChange={(next) => !next && setSuccess(null)} open={success !== null}>
        <AlertDialogContent initialFocus={finishButton}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('scenario-panel.success.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('scenario-panel.success.saved-to')}</AlertDialogDescription>
          </AlertDialogHeader>
          <CopyPathField
            copiedLabel={t('scenario-panel.success.path.copied')}
            copyLabel={t('scenario-panel.success.path.copy')}
            inputLabel={t('scenario-panel.success.path')}
            value={success?.path ?? null}
          />
          <p className="managed-mod-success-note">{t('scenario-panel.success.note')}</p>
          <AlertDialogFooter>
            <Button
              disabled={openFolderBusy}
              onClick={() => void openDeployedScenario()}
              type="button"
              variant="secondary"
            >
              {t('scenario-panel.success.open-folder')}
            </Button>
            <AlertDialogAction onClick={() => setSuccess(null)} ref={finishButton} type="button">
              {t('deploy-panel.success.finish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function scenarioProblemText(problem: ScenarioProblem, t: ReturnType<typeof useI18n>['t']): string {
  switch (problem.kind) {
    case 'deployment':
      return outputMessageText(presentDeploymentFailure(problem.raw));
    case 'refused-folder':
      return refusedGameFolderText(problem.report);
    case 'source-failed':
      return deploymentSourceFailureMessage(deploymentSourceGuidance(problem.detail));
    case 'source-cancelled':
      return t('deploy-panel.source.cancelled');
    case 'unavailable':
      return t('scenario-panel.unavailable');
    case 'text':
      return wordOutputWords(problem.text);
  }
}
