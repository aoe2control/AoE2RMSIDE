import {
  liveWorkflowStages,
  type ControlLiveWorkflowEvent,
  type ControlSessionEvent,
  type LiveWorkflowStage,
} from '../shared/api';
import { t, type MessageId } from '../shared/i18n/translator';

export const liveTestSteps = [
  'preview',
  'connecting',
  'checking-control',
  ...liveWorkflowStages,
] as const;
export type LiveTestStep = (typeof liveTestSteps)[number];

export type LiveTestWait = 'engine-unloading' | 'engine-starting';

export interface LiveTestProgress {
  phase: 'idle' | 'running' | 'completed';
  step: LiveTestStep;
  wait: LiveTestWait | null;
  run: number;
}

export const idleLiveTestProgress: LiveTestProgress = Object.freeze({
  phase: 'idle',
  step: 'preview',
  wait: null,
  run: 0,
});

export type LiveTestProgressInput =
  | { kind: 'initiated' }
  | { kind: 'control' }
  | { kind: 'session'; event: Pick<ControlSessionEvent, 'kind' | 'detailCode'> }
  | { kind: 'workflow'; event: Pick<ControlLiveWorkflowEvent, 'kind' | 'detailCode'> }
  | { kind: 'verified' }
  | { kind: 'preview-stopped' }
  | { kind: 'ended' };

export function nextLiveTestProgress(
  state: LiveTestProgress,
  input: LiveTestProgressInput,
): LiveTestProgress {
  switch (input.kind) {
    case 'initiated':
      return { phase: 'running', step: 'preview', wait: null, run: state.run + 1 };
    case 'control':
      return state.phase === 'running'
        ? advance(state, 'connecting')
        : { phase: 'running', step: 'connecting', wait: null, run: state.run + 1 };
    case 'verified':
      return state.phase === 'running' ? { ...state, phase: 'completed', wait: null } : state;
    case 'preview-stopped':
      return state.phase === 'running' && state.step === 'preview' ? ended(state) : state;
    case 'ended':
      return state.phase === 'idle' ? state : ended(state);
    case 'session':
      return state.phase === 'running' ? afterSessionEvent(state, input.event) : state;
    case 'workflow':
      return state.phase === 'running' ? afterWorkflowEvent(state, input.event) : state;
  }
}

function afterSessionEvent(
  state: LiveTestProgress,
  event: Pick<ControlSessionEvent, 'kind' | 'detailCode'>,
): LiveTestProgress {
  switch (event.kind) {
    case 'startup':
      if (stepIndex(state.step) > stepIndex('connecting')) return state;
      return {
        ...advance(state, 'connecting'),
        wait:
          event.detailCode === 'waiting-for-engine-unload'
            ? 'engine-unloading'
            : event.detailCode === 'waiting-for-engine-start'
              ? 'engine-starting'
              : state.wait,
      };
    case 'game-detected':
      return advance(state, 'connecting');
    case 'attach':
      return stepIndex(state.step) > stepIndex('connecting')
        ? state
        : { ...advance(state, 'connecting'), wait: null };
    case 'handshake':
      return advance(state, 'checking-control');
    case 'ready':
      return advance(state, 'checking-game');
    case 'failure':
    case 'cancelled':
    case 'detached':
      return state;
  }
}

function afterWorkflowEvent(
  state: LiveTestProgress,
  event: Pick<ControlLiveWorkflowEvent, 'kind' | 'detailCode'>,
): LiveTestProgress {
  switch (event.kind) {
    case 'stage':
      return isWorkflowStage(event.detailCode) ? advance(state, event.detailCode) : state;
    case 'startup':
      return advance(state, 'connecting');
    case 'handshake':
      return advance(state, 'checking-game');
    case 'clean-end':
      return advance(state, 'ending-match');
    case 'deploy':
      return advance(state, 'copying-map');
    case 'catalog-refresh':
      return advance(state, 'selecting-map');
    case 'start':
      return advance(state, 'verifying');
    case 'effective-readback':
      return { ...state, phase: 'completed', wait: null };
    case 'failure':
    case 'cancellation':
      return ended(state);
  }
}

function advance(state: LiveTestProgress, step: LiveTestStep): LiveTestProgress {
  if (stepIndex(step) < stepIndex(state.step)) return state;
  if (step === state.step) return state;
  return { ...state, step, wait: null };
}

function ended(state: LiveTestProgress): LiveTestProgress {
  return { ...state, phase: 'idle', wait: null };
}

function stepIndex(step: LiveTestStep): number {
  return liveTestSteps.indexOf(step);
}

function isWorkflowStage(value: string): value is LiveWorkflowStage {
  return (liveWorkflowStages as readonly string[]).includes(value);
}

export function liveTestProgressPercent(state: LiveTestProgress): number {
  if (state.phase === 'completed') return 100;
  return Math.round((stepIndex(state.step) / liveTestSteps.length) * 100);
}

const stepWords: Readonly<Record<LiveTestStep, { word: MessageId; detail: MessageId }>> = {
  preview: { word: 'live-test.progress.preview', detail: 'live-test.progress.preview.detail' },
  connecting: {
    word: 'live-test.progress.connecting',
    detail: 'live-test.progress.connecting.detail',
  },
  'checking-control': {
    word: 'live-test.progress.checking',
    detail: 'live-test.progress.checking-control.detail',
  },
  'checking-game': {
    word: 'live-test.progress.checking',
    detail: 'live-test.progress.checking-game.detail',
  },
  'ending-match': {
    word: 'live-test.progress.ending',
    detail: 'live-test.progress.ending-match.detail',
  },
  'copying-map': {
    word: 'live-test.progress.copying',
    detail: 'live-test.progress.copying-map.detail',
  },
  'selecting-map': {
    word: 'live-test.progress.selecting',
    detail: 'live-test.progress.selecting-map.detail',
  },
  'starting-match': {
    word: 'live-test.progress.starting',
    detail: 'live-test.progress.starting-match.detail',
  },
  verifying: {
    word: 'live-test.progress.verifying',
    detail: 'live-test.progress.verifying.detail',
  },
};

const waitWords: Readonly<Record<LiveTestWait, MessageId>> = {
  'engine-unloading': 'live-test.progress.engine-unloading.detail',
  'engine-starting': 'live-test.progress.engine-starting.detail',
};

export function liveTestProgressWord(state: LiveTestProgress): string {
  if (state.phase === 'completed') return t('live-test.progress.verified');
  if (state.wait) return t('live-test.progress.waiting');
  return t(stepWords[state.step].word);
}

export function liveTestProgressDetail(state: LiveTestProgress): string {
  if (state.phase === 'completed') return t('live-test.progress.verified.detail');
  const words = state.wait ? waitWords[state.wait] : stepWords[state.step].detail;
  return t(words, { step: stepIndex(state.step) + 1, total: liveTestSteps.length });
}
