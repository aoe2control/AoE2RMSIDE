import { generationResultWords, presentMessage } from '../shared/message-catalog';
import { outputMessageText, outputNote, type OutputMessage } from '../shared/output-message';
import type {
  GenerationCertification,
  ManagedDeploymentResult,
  ManualDeploymentModStatus,
  ManualDeploymentOwnedTarget,
  PreviewGenerationResult,
} from '../shared/api';
import { fallbackPersistentModName, modNameFromScriptName } from '../shared/persistent-mod-name';
import { t } from '../shared/i18n/translator';
import {
  maximumNamedUncertifiedConstructs,
  uncertifiedConstructList,
} from '../shared/construct-verification';
import { constructVerificationNote } from './construct-verification-message';
import type { PreviewRunState } from './preview-execution';

export interface DeploymentPreviewOutcome<Inputs, Preview> {
  inputs: Inputs;
  preview: Preview | null;
  error: string | null;
}

export interface DeploymentPreviewPhase<Preview> {
  loading: boolean;
  preview: Preview | null;
  error: string | null;
}

export function deploymentPreviewPhase<Inputs, Preview>(
  inputs: Inputs | null,
  outcome: DeploymentPreviewOutcome<Inputs, Preview> | null,
): DeploymentPreviewPhase<Preview> {
  if (inputs === null) return { loading: false, preview: null, error: null };
  if (!outcome || outcome.inputs !== inputs) return { loading: true, preview: null, error: null };
  return { loading: false, preview: outcome.preview, error: outcome.error };
}

export interface DeploymentPreviewShown<Preview> {
  preview: Preview | null;
  error: string | null;
  retained: boolean;
}

export function deploymentPreviewShown<Graph, Inputs extends { graph: Graph }, Preview>(
  graph: Graph | null,
  phase: DeploymentPreviewPhase<Preview>,
  iconPending: boolean,
  outcome: DeploymentPreviewOutcome<Inputs, Preview> | null,
): DeploymentPreviewShown<Preview> {
  if (
    graph !== null &&
    outcome !== null &&
    outcome.inputs.graph === graph &&
    (phase.loading || iconPending)
  ) {
    return { preview: outcome.preview, error: outcome.error, retained: true };
  }
  return { preview: phase.preview, error: phase.error, retained: false };
}

export interface ManagedModTreePendingState {
  open: boolean;
  initializing: boolean;
  sourceLoading: boolean;
  contextLoading: boolean;
  previewLoading: boolean;
  awaitingIconRender: boolean;
}

export function managedModTreePending(state: ManagedModTreePendingState): boolean {
  if (!state.open) return false;
  return (
    state.initializing ||
    state.sourceLoading ||
    state.contextLoading ||
    state.previewLoading ||
    state.awaitingIconRender
  );
}

export function deploymentPanelError<Problem>(errors: {
  action: Problem | null;
  context: Problem | null;
  source: Problem | null;
  preview: Problem | null;
}): Problem | null {
  return errors.action ?? errors.context ?? errors.source ?? errors.preview;
}

export function deploymentSourceFailureMessage(guidance: string | null): string {
  return guidance
    ? t('deploy-panel.source.failed.guidance', { guidance })
    : t('deploy-panel.source.failed');
}

export function deploymentSourceGuidance(detail: string): string | null {
  const message = deploymentSourceFailureOutput(detail);
  return message.code === 'unknown' ? null : outputMessageText(message);
}

export function deploymentSourceFailureOutput(detail: string): OutputMessage {
  return presentMessage({
    source: 'Deploy',
    raw: detail,
    fallbackHeadline: 'deploy-panel.output.source-failed',
  });
}

export interface PendingSourceRunObservation {
  started: boolean;
  runState: PreviewRunState;
  executionIdle: boolean;
  completedSinceScheduled: boolean;
  committedForSource: boolean;
}

export type CopyPathAlignment = 'start' | 'end';

export function copyPathAlignment(
  valueWidth: number,
  fieldWidth: number,
): CopyPathAlignment | null {
  if (!Number.isFinite(valueWidth) || !Number.isFinite(fieldWidth) || fieldWidth <= 0) {
    return null;
  }
  return valueWidth > fieldWidth + 0.5 ? 'end' : 'start';
}

export function deploymentTargetDirectory(
  targetPath: string | null | undefined,
  targetRoot: string | null | undefined,
): string | null {
  if (targetPath) {
    const trimmed = targetPath.replace(/[\\/]+$/u, '');
    const separator = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (separator > 0) return trimmed.slice(0, separator);
  }
  return targetRoot || null;
}

export type PendingSourceRunSettlement = 'wait' | 'started' | 'completed' | 'failed' | 'cancelled';

export function pendingSourceRunSettlement(
  observation: PendingSourceRunObservation,
): PendingSourceRunSettlement {
  if (observation.completedSinceScheduled && observation.committedForSource) return 'completed';
  if (!observation.started) return observation.runState === 'running' ? 'started' : 'wait';
  if (observation.runState === 'error') return 'failed';
  if (observation.runState === 'idle' && observation.executionIdle) return 'cancelled';
  return 'wait';
}

export function deploymentCertificationNote(
  certification: GenerationCertification | undefined,
): string | null {
  return certification === 'unverified-product-version'
    ? generationResultWords.deploymentUnverifiedVersion
    : null;
}

export function deploymentConstructNote(
  result:
    Pick<PreviewGenerationResult, 'certification' | 'constructVerification'> | null | undefined,
): { note: string; names: string } | null {
  if (result?.certification !== 'version-mapped') return null;
  const verification = result.constructVerification;
  const note = constructVerificationNote(verification);
  if (!note || !verification) return null;
  return {
    note,
    names: uncertifiedConstructList(verification, maximumNamedUncertifiedConstructs),
  };
}

export interface ModNameField {
  value: string;
  automatic: boolean;
}

export const initialModNameField: ModNameField = {
  value: fallbackPersistentModName,
  automatic: true,
};

export function suggestedModName(
  ownedTargets: readonly ManualDeploymentOwnedTarget[],
  profileId: string,
  source: { uri: string; name: string } | null,
): string {
  if (!source) return fallbackPersistentModName;
  const remembered = profileId
    ? ownedTargets.find(
        (target) => target.profileId === profileId && target.documentUri === source.uri,
      )
    : undefined;
  return remembered?.modName ?? modNameFromScriptName(source.name);
}

export function withSuggestedModName(field: ModNameField, suggestion: string): ModNameField {
  if (!field.automatic || field.value === suggestion) return field;
  return { value: suggestion, automatic: true };
}

export function editedModNameField(value: string): ModNameField {
  return { value, automatic: false };
}

export function closedModNameField(field: ModNameField): ModNameField {
  return field.automatic ? field : { value: field.value, automatic: true };
}

const enableModPreferenceKey = 'rmside.deploy.enable-mod.v1';

export function readEnableModPreference(storage: Pick<Storage, 'getItem'>): boolean {
  try {
    return storage.getItem(enableModPreferenceKey) !== 'off';
  } catch {
    return true;
  }
}

export function writeEnableModPreference(
  storage: Pick<Storage, 'setItem'>,
  enabled: boolean,
): void {
  try {
    storage.setItem(enableModPreferenceKey, enabled ? 'on' : 'off');
  } catch {}
}

function changedModList(status: ManualDeploymentModStatus | undefined): boolean {
  return status?.enable === 'enabled' || status?.enable === 'added';
}

function modEnabled(status: ManualDeploymentModStatus | undefined): boolean {
  return changedModList(status) || status?.enable === 'already-enabled';
}

export interface DeploymentModStatusLines {
  note: string;
  failure: string | null;
  warning: string | null;
}

export function deploymentModStatusLines(
  status: ManualDeploymentModStatus | undefined,
): DeploymentModStatusLines {
  return {
    note: modEnabled(status)
      ? t('deploy-panel.success.enabled')
      : t('deploy-panel.success.enable-yourself'),
    failure:
      status?.enable === 'failed'
        ? t('deploy-panel.success.enable-failed', { reason: status.failure ?? 'write-failed' })
        : null,
    warning:
      changedModList(status) && status?.gameRunning ? t('deploy-panel.success.game-running') : null,
  };
}

export function deploymentOutputMessages(result: ManagedDeploymentResult): OutputMessage[] {
  const status = result.modStatus;
  const count = result.deployedFiles.length;
  const messages = [
    outputNote(
      'Deploy',
      'deploy.deployed',
      {
        id: 'deploy-panel.output.deployed',
        args: { mod: result.modName, profile: result.profileId },
      },
      {
        cause: modEnabled(status)
          ? { id: 'deploy-panel.output.cause.enabled', args: { count } }
          : { id: 'deploy-panel.output.cause.enable-yourself', args: { count } },
      },
    ),
  ];
  if (status?.enable === 'failed') {
    messages.push(
      outputNote(
        'Deploy',
        'deploy.mod-enable-failed',
        { id: 'deploy-panel.output.enable-failed' },
        {
          severity: 'warning',
          cause: {
            id: 'deploy-panel.output.enable-failed.cause',
            args: { reason: status.failure ?? 'write-failed' },
          },
          action: { text: { id: 'deploy-panel.output.enable-failed.action' } },
          ...(status.detail ? { detail: status.detail } : {}),
        },
      ),
    );
  }
  if (changedModList(status) && status?.gameRunning) {
    messages.push(
      outputNote(
        'Deploy',
        'deploy.game-running',
        { id: 'deploy-panel.output.game-running' },
        {
          severity: 'warning',
          cause: { id: 'deploy-panel.output.game-running.cause' },
        },
      ),
    );
  }
  return messages;
}
