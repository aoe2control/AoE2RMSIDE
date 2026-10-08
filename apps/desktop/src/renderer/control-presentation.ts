import type {
  ControlLastTransaction,
  ControlLauncherStatus,
  ControlLiveWorkflowEvent,
  ControlSessionEvent,
  ControlSessionStatus,
  ControlSetupContext,
} from '../shared/api';
import { t } from '../shared/i18n/translator';
import { desktopRefusal, presentMessage } from '../shared/message-catalog';
import { outputMessageText, type OutputMessage } from '../shared/output-message';
import type {
  LiveControlConnectionState,
  LiveControlPresentation,
  LiveSynchronizationState,
} from './preview-execution';

export interface MatchSeedAvailability {
  available: boolean;
  reason: string | null;
  seed?: number;
}

export type LiveWorkflowEvent =
  | { kind: 'headless-engine-startup' }
  | { kind: 'engine-unloading' }
  | { kind: 'engine-starting' }
  | { kind: 'game-detected' }
  | { kind: 'attach' }
  | { kind: 'handshake' }
  | { kind: 'ready' }
  | { kind: 'clean-end' }
  | { kind: 'managed-source-deploy'; xsFiles?: readonly string[] }
  | { kind: 'managed-source-current' }
  | { kind: 'managed-catalog-refresh' }
  | { kind: 'match-start'; seed: number }
  | {
      kind: 'effective-readback';
      seed: number;
      matchEpoch: number;
      unverifiedProductVersion?: string;
    }
  | { kind: 'cancelled' }
  | {
      kind: 'failure';
      detailCode: string;
      detail?: string;
      recovery?: true;
    }
  | { kind: 'detached' };

export function controlPresentation(
  launcher: ControlLauncherStatus,
  session?: ControlSessionStatus | null,
): LiveControlPresentation {
  const connectionState = presentConnection(session?.connection ?? 'disconnected');
  const transaction = session?.endpoint?.lastTransaction;
  return {
    configured: launcher.configured,
    staticallyValid: launcher.state === 'ready',
    displayName: launcher.executableName ?? 'AoE2Control',
    ...(session?.capabilities?.identity.control.productVersion
      ? { productVersion: session.capabilities.identity.control.productVersion }
      : {}),
    connectionState,
    synchronizationState: presentSynchronization(transaction?.state),
    ...(transaction?.requestedSeed !== undefined
      ? { requestedSeed: transaction.requestedSeed }
      : {}),
    ...(transaction?.effectiveSeed !== null && transaction?.effectiveSeed !== undefined
      ? { effectiveSeed: transaction.effectiveSeed }
      : {}),
    ...(transaction?.matchEpoch !== null && transaction?.matchEpoch !== undefined
      ? { matchEpoch: transaction.matchEpoch }
      : {}),
    ...(presentationDetail(launcher, session)
      ? { detail: presentationDetail(launcher, session) }
      : {}),
  };
}

export function matchSeedAvailability(
  launcher: ControlLauncherStatus,
  session?: ControlSessionStatus | null,
): MatchSeedAvailability {
  if (launcher.state !== 'ready') {
    return {
      available: false,
      reason: launcher.configured
        ? t('live-test.seed.select-valid-control')
        : t('live-test.seed.configure-control'),
    };
  }
  if (!session || session.connection === 'disconnected' || session.connection === 'failed') {
    return { available: true, reason: null };
  }
  if (session.connection !== 'ready') {
    return {
      available: false,
      reason: t('live-test.seed.connecting'),
    };
  }
  const endpoint = session.endpoint;
  if (!endpoint) {
    return {
      available: false,
      reason: t('live-test.seed.readback-unavailable'),
    };
  }
  if (endpoint.match.replay) {
    return { available: false, reason: t('live-test.seed.replay') };
  }
  if (endpoint.match.multiplayer) {
    return { available: false, reason: t('live-test.seed.multiplayer') };
  }
  if (
    endpoint.safety.verified !== true ||
    (endpoint.safety.sessionState !== 'single-player-active' &&
      endpoint.safety.sessionState !== 'single-player-ready')
  ) {
    return {
      available: false,
      reason: t('live-test.seed.state-changing'),
    };
  }
  if (!endpoint.match.active) {
    return { available: false, reason: t('live-test.seed.no-match') };
  }
  const transactionSetup = activeTransactionSetup(endpoint.lastTransaction, endpoint);
  const observedModes = [
    endpoint.currentSetup?.gameMode,
    transactionSetup?.gameMode,
    endpoint.currentGameMode ?? undefined,
  ].filter((mode): mode is ControlSetupContext['gameMode'] => mode !== undefined);
  if (observedModes.length === 0) {
    return {
      available: false,
      reason: t('live-test.seed.setup-unreadable'),
    };
  }
  if (observedModes.some((mode) => mode !== observedModes[0])) {
    return {
      available: false,
      reason: t('live-test.seed.state-changing'),
    };
  }
  if (observedModes[0] !== 'random-map') {
    return { available: false, reason: t('live-test.seed.not-random-map') };
  }
  const seed = endpoint.effectiveSeed;
  if (!isUint32(seed)) {
    return {
      available: false,
      reason: t('live-test.seed.seed-unreadable'),
    };
  }
  return { available: true, reason: null, seed };
}

function activeTransactionSetup(
  transaction: ControlLastTransaction | null,
  endpoint: ControlSessionStatus['endpoint'],
): ControlLastTransaction['effectiveSetup'] {
  if (
    !transaction ||
    !endpoint ||
    transaction.state !== 'active-verified' ||
    transaction.matchEpoch !== endpoint.match.matchEpoch ||
    transaction.effectiveSeed !== endpoint.effectiveSeed
  ) {
    return null;
  }
  return transaction.effectiveSetup;
}

export function workflowEventFromControl(event: ControlSessionEvent): LiveWorkflowEvent {
  switch (event.kind) {
    case 'startup':
      if (event.detailCode === 'waiting-for-engine-unload') return { kind: 'engine-unloading' };
      if (event.detailCode === 'waiting-for-engine-start') return { kind: 'engine-starting' };
      return { kind: 'headless-engine-startup' };
    case 'game-detected':
      return { kind: 'game-detected' };
    case 'attach':
      return { kind: 'attach' };
    case 'handshake':
      return { kind: 'handshake' };
    case 'ready':
      return { kind: 'ready' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failure':
      return {
        kind: 'failure',
        detailCode: event.detailCode,
        ...(event.detail ? { detail: event.detail } : {}),
        ...(event.recovery ? { recovery: true as const } : {}),
      };
    case 'detached':
      return { kind: 'detached' };
  }
}

export function workflowEventFromLive(event: ControlLiveWorkflowEvent): LiveWorkflowEvent | null {
  switch (event.kind) {
    case 'stage':
      return null;
    case 'startup':
      return { kind: 'headless-engine-startup' };
    case 'handshake':
      return { kind: 'handshake' };
    case 'clean-end':
      return { kind: 'clean-end' };
    case 'deploy':
      return event.detailCode === 'managed-source-current'
        ? { kind: 'managed-source-current' }
        : {
            kind: 'managed-source-deploy',
            ...(event.xsFiles?.length ? { xsFiles: [...event.xsFiles] } : {}),
          };
    case 'catalog-refresh':
      return { kind: 'managed-catalog-refresh' };
    case 'start':
      return { kind: 'match-start', seed: event.seed ?? 0 };
    case 'effective-readback':
      return {
        kind: 'effective-readback',
        seed: event.seed ?? 0,
        matchEpoch: event.matchEpoch ?? 0,
      };
    case 'cancellation':
      return { kind: 'cancelled' };
    case 'failure':
      return {
        kind: 'failure',
        detailCode: event.detailCode,
        ...(event.detail ? { detail: event.detail } : {}),
      };
  }
}

function liveWorkflowCode(event: LiveWorkflowEvent): string {
  switch (event.kind) {
    case 'headless-engine-startup':
      return 'live.engine-startup';
    case 'engine-unloading':
      return 'live.engine-unloading';
    case 'engine-starting':
      return 'live.engine-starting';
    case 'game-detected':
      return 'live.game-detected';
    case 'attach':
      return 'live.attach';
    case 'handshake':
      return 'live.handshake';
    case 'ready':
      return 'live.ready';
    case 'clean-end':
      return 'live.clean-end';
    case 'managed-source-deploy':
      return 'live.deploy';
    case 'managed-source-current':
      return 'live.deploy-current';
    case 'managed-catalog-refresh':
      return 'live.catalog-refresh';
    case 'match-start':
      return 'live.match-start';
    case 'effective-readback':
      return 'live.verified';
    case 'cancelled':
      return 'live.cancelled';
    case 'failure':
      return controlCode(event.detailCode);
    case 'detached':
      return 'live.detached';
  }
}

function controlCode(detailCode: string | null | undefined): string {
  return detailCode && /^[A-Za-z0-9_-]{1,64}$/u.test(detailCode)
    ? `control.${detailCode}`
    : 'control.unrecognized';
}

export function liveWorkflowMessage(event: LiveWorkflowEvent): OutputMessage {
  if (event.kind === 'failure' && event.detailCode === 'live-test-failed' && event.detail) {
    return liveFailureMessage(event.detail);
  }
  return presentMessage({
    source: 'Live test',
    code: liveWorkflowCode(event),
    ...(event.kind === 'failure' && event.detail ? { raw: event.detail } : {}),
    params:
      event.kind === 'match-start'
        ? { seed: event.seed }
        : event.kind === 'effective-readback'
          ? { seed: event.seed, unverifiedVersion: event.unverifiedProductVersion }
          : event.kind === 'managed-source-deploy' && event.xsFiles?.length
            ? { xsFiles: event.xsFiles.join('/') }
            : {},
  });
}

export interface LiveOutputGateState {
  attached: boolean;
}

export const initialLiveOutputGate: LiveOutputGateState = { attached: false };

export function liveOutputGate(
  state: LiveOutputGateState,
  event: LiveWorkflowEvent,
): { state: LiveOutputGateState; visible: boolean } {
  switch (event.kind) {
    case 'game-detected':
    case 'attach':
    case 'handshake':
    case 'managed-source-current':
    case 'managed-catalog-refresh':
      return { state, visible: false };
    case 'ready':
      return { state: { attached: true }, visible: !state.attached };
    case 'headless-engine-startup':
    case 'engine-starting':
    case 'engine-unloading':
      return { state, visible: !state.attached };
    case 'failure':
      if (event.recovery) return { state, visible: false };
      return { state: { attached: false }, visible: true };
    case 'detached':
      return { state: { attached: false }, visible: state.attached };
    default:
      return { state, visible: true };
  }
}

export function unverifiedLiveGameVersion(session?: ControlSessionStatus | null): string | null {
  return session?.gameVersion?.verification === 'unverified'
    ? session.gameVersion.productVersion
    : null;
}

export function unverifiedLiveGameMessage(productVersion: string): OutputMessage {
  return presentMessage({
    source: 'Live test',
    code: 'live.unverified-game',
    params: { version: productVersion },
  });
}

const knownControlFailureCodes = [
  'game-not-detected',
  'launcher-exited-before-start',
  'launcher-start-timeout',
  'injection-handshake-timeout',
  'unsupported-game-version',
  'control-civilization-unsupported',
  'game-civilization-unavailable',
  'endpoint-civilization_unavailable_in_control_catalog',
  'launcher-still-unloading',
  'launcher-engine-starting-timeout',
  'launcher-startup-timeout',
  'launcher-game-not-ready',
  'launcher-engine-incompatible',
  'launcher-engine-failed-earlier',
  'launcher-injection-failed',
  'launcher-launcher-already-running',
  'malformed-launcher-status',
  'launcher-crashed',
  'launcher-engine-failure',
  'launcher-engine-mismatch',
  'stale-reused-engine',
  'endpoint-unavailable',
  'endpoint-timeout',
  'incompatible-control-capabilities',
  'unsafe-or-unknown-session',
  'stale-safety-observation',
  'effective-readback-mismatch',
  'start-transaction-mismatch',
  'invalid-setup',
  'capability-mismatch',
  'connection-lost',
  'deployment-identity-invalid',
  'deployment-preview-mismatch',
  'managed-deployment-failed',
  'deployment-target-unavailable',
  'control-lobby-options-unsupported',
  'match-start-unresponsive',
  'active-verification-timeout',
  'clean-end-timeout',
  'xs-profile-file-not-owned',
  'xs-profile-file-changed',
  'xs-profile-name-invalid',
  'xs-profile-name-collision',
  'xs-profile-folder-unsafe',
  'xs-profile-record-invalid',
  'xs-profile-staging-failed',
  'xs-syntax',
  'active-match-confirmation-required',
  'clean-end-rejected',
  'session-changed-before-mutation',
  'session-identity-changed',
  'managed-source-unavailable',
  'ambiguous-managed-source',
  'stale-or-nonexact-preview',
  'invalid-setup-player',
  'invalid-session-identity',
  'invalid-catalog-generation',
  'unsupported-live-contract',
  'invalid-live-request',
  'invalid-preview-identity',
  'invalid-preview-options',
  'invalid-ending-age',
] as const;

export function controlFailureCode(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const bridge = /AoE2Control session failed: ([A-Za-z0-9_-]+)/u.exec(message);
  if (bridge) return bridge[1]!;
  for (const [, code] of message.matchAll(/\(([A-Za-z0-9_-]{1,64})\)/gu)) {
    if (code === 'cancelled' || (knownControlFailureCodes as readonly string[]).includes(code!)) {
      return code!;
    }
  }
  const known = knownControlFailureCodes.find((code) => message.includes(code));
  if (known) return known;
  if (
    message.includes('select a numeric AoE2DE user profile') ||
    message.includes('select an AoE2DE installation') ||
    message.includes('selected AoE2DE installation is unavailable') ||
    message.includes('selected AoE2DE user profile is unavailable') ||
    message.includes('current AoE2DE user profile could not be identified')
  ) {
    return 'deployment-target-unavailable';
  }
  if (
    message.includes('deployment') ||
    message.includes('managed mod') ||
    message.includes('source catalog')
  ) {
    return 'managed-deployment-failed';
  }
  return null;
}

export function liveFailureMessage(error: unknown): OutputMessage {
  const raw = error instanceof Error ? error.message : String(error);
  const desktop = /AoE2Control session failed: /u.test(raw) ? null : desktopRefusal(raw);
  if (desktop) return presentMessage({ source: 'Live test', code: desktop.code, raw });
  const code = controlFailureCode(error);
  const rollbackFields =
    code === 'rollback-incomplete'
      ? (/rollback-incomplete \([^;)]*; ([^)]*)\)/u.exec(raw)?.[1] ?? '')
      : undefined;
  return presentMessage({
    source: 'Live test',
    code: controlCode(code),
    raw,
    ...(rollbackFields !== undefined ? { params: { rollbackFields } } : {}),
  });
}

function presentConnection(state: ControlSessionStatus['connection']): LiveControlConnectionState {
  switch (state) {
    case 'disconnected':
      return 'disconnected';
    case 'launching':
    case 'game-detected':
    case 'handshaking':
      return 'connecting';
    case 'ready':
      return 'attached';
    case 'failed':
      return 'error';
  }
}

function presentSynchronization(
  state: ControlLastTransaction['state'] | undefined,
): LiveSynchronizationState {
  switch (state) {
    case 'dispatched':
    case 'active-verifying':
      return 'synchronizing';
    case 'active-verified':
      return 'active-verified';
    case 'active-readback-mismatch':
      return 'error';
    case undefined:
      return 'idle';
  }
}

function presentationDetail(
  launcher: ControlLauncherStatus,
  session?: ControlSessionStatus | null,
): string | undefined {
  switch (launcher.state) {
    case 'missing':
      return t('live-test.control.missing');
    case 'changed':
      return t('live-test.control.changed');
    case 'invalid':
      return t('live-test.control.invalid');
    case 'unconfigured':
    case 'ready':
      break;
  }
  if (session?.connection === 'failed') {
    return controlFailureSummary(session.detailCode);
  }
  return undefined;
}

export function controlFailureSummary(detailCode?: string): string {
  const message = presentMessage({ source: 'Live test', code: controlCode(detailCode) });
  return outputMessageText(message);
}

function isUint32(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffff_ffff;
}
