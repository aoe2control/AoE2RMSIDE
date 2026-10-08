import type {
  DevelopmentFixtureDescriptor,
  PreviewGenerationEvent,
  PreviewGenerationResult,
  RootExecutionState,
} from '../shared/api';
import { desktopErrorFacts } from '../shared/desktop-error';
import { t } from '../shared/i18n/translator';
import type { OutputWords } from '../shared/output-message';
import { isMapTestScriptName, type MapTestWorkerSetting } from '../shared/map-test-contract';
import type { LiveControlAction } from './live-control-action';
import type { LivePreviewStatus } from './live-preview';
import type { PreviewCacheDiagnostics } from './preview-cache';

export type PreviewRunState = 'idle' | 'running' | 'success' | 'error';

export type LiveControlConnectionState =
  'disconnected' | 'connecting' | 'attached' | 'recovering' | 'error';

export type LiveSynchronizationState =
  'idle' | 'preview-current' | 'synchronizing' | 'active-verified' | 'error';

export interface LiveControlPresentation {
  configured: boolean;
  staticallyValid: boolean;
  displayName: string;
  productVersion?: string;
  connectionState: LiveControlConnectionState;
  synchronizationState: LiveSynchronizationState;
  requestedSeed?: number;
  effectiveSeed?: number;
  matchEpoch?: number;
  detail?: string;
}

export interface PreviewStatusDetails extends LivePreviewStatus {
  backendIdentity: string;
  profileId: string;
  seed: number;
  settings: string;
  uncertified: boolean;
  certification?: string;
  generationEvent?: PreviewGenerationEvent;
}

export interface PreviewVersionNotice {
  cause: string;
  action: 'use-local-version' | 'link-game-folder' | null;
}

export interface PreviewExecutionController {
  blockingReason: string | null;
  canRun: boolean;
  controlSelectionBusy: boolean;
  gameInstallationBusy: boolean;
  gameInstallationReady: boolean;
  gameInstallationSelectionBusy: boolean;
  liveTestOnRun: boolean;
  runOnEdit: boolean;
  runOnSave: boolean;
  runState: PreviewRunState;
  executionState: RootExecutionState;
  seed: number;
  seedLocked: boolean;
  settingsLoaded: boolean;
  status: PreviewStatusDetails | null;
  cacheDiagnostics: PreviewCacheDiagnostics;
  completedRunSequence: number;
  clearPreviewCache(): void;
  developmentFixtures: DevelopmentFixtureDescriptor[];
  control?: LiveControlPresentation;
  controlAction?: LiveControlAction;
  canAdoptMatchSeed?: boolean;
  adoptMatchSeedBlockingReason?: string | null;
  run(): void;
  runSource(source: PinnedPreviewSource): PreviewSourceRunAcceptance;
  reusableCommittedResult?(source: PinnedPreviewSource): ReusableCommittedPreview | null;
  stop(): void;
  adoptMatchSeed?(): void;
  detachControl?(): void;
  forgetControl?(): void;
  runDevelopmentFixture(fixtureId: DevelopmentFixtureDescriptor['id']): void;
  selectControl?(): void;
  selectGameFolder?(): void;
  versionNotice?: PreviewVersionNotice | null;
  unverifiedVersionDescription?: string | null;
  useLocalVersion?(): void;
  setSeed(seed: number): void;
  mapTestWorkers?: MapTestWorkerSetting;
  setMapTestWorkers?(workers: MapTestWorkerSetting): void;
  explainBlockedRun?(): void;
  toggleLiveTestOnRun(): void;
  toggleRunOnEdit(): void;
  toggleRunOnSave(): void;
  toggleSeedMode(): void;
}

export interface ReusableCommittedPreview {
  result: PreviewGenerationResult;
  seed: number;
}

export type PreviewSourceRunAcceptance =
  { status: 'scheduled' } | { status: 'blocked'; reason: OutputWords; retryable: boolean };

export interface PinnedPreviewSource {
  id: string;
  uri: string;
  name: string;
  content: string;
}

export function previewSeedControls(
  execution: Pick<PreviewExecutionController, 'seedLocked' | 'settingsLoaded'> | null,
): { editable: boolean; copyable: boolean; modeToggleable: boolean } {
  const loaded = Boolean(execution?.settingsLoaded);
  return {
    editable: loaded && Boolean(execution?.seedLocked),
    copyable: loaded && !execution?.seedLocked,
    modeToggleable: loaded,
  };
}

export function isStaleExactPreviewError(message: string): boolean {
  return /stale or unavailable|do not match the current catalog|current successful preview revision|changed while generation was in flight|cannot authorize a mismatched deployment graph/u.test(
    message,
  );
}

export function isPreviewSourceChangedError(message: string): boolean {
  return (
    /source catalog changed while generation was in flight/u.test(message) ||
    desktopErrorFacts(message)?.code === 'generation.source-changed'
  );
}

export function isPreviewScriptName(name: string): boolean {
  return /\.(?:rms|rms2)$/iu.test(name);
}

export function includeOnlyRunBlockingReason(): string {
  return t('preview-panel.run.include-only');
}

export function runnableDocumentBlockingReason(name: string): string | null {
  return isPreviewScriptName(name) || isMapTestScriptName(name)
    ? null
    : includeOnlyRunBlockingReason();
}
