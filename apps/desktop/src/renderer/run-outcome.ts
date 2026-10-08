import {
  messageCode,
  presentMessage,
  rewordOutputMessage,
  type MessageInput,
} from '../shared/message-catalog';
import { activeTranslator, englishTranslator, type MessageId } from '../shared/i18n/translator';
import { sentence, type OutputMessage, type OutputSource } from '../shared/output-message';

export type RunTrigger = 'explicit' | 'automatic';

export type RunFailureStage = 'request' | 'analysis' | 'generation' | 'map-test';

export type RunOutcome =
  | {
      kind: 'failed';
      stage: RunFailureStage;
      message: string;
      presentation?: OutputMessage;
    }
  | { kind: 'cancelled' }
  | { kind: 'superseded'; reason: 'newer-run' | 'source-changed' | 'other-execution' };

export interface ExecutionFailureNoticeContent {
  title: string;
  detail: string | null;
  presentation: OutputMessage;
}

export interface RunOutcomeEffects {
  notice: ExecutionFailureNoticeContent | null;
  clearMap: boolean;
  discardCandidate: true;
}

const noEffects: RunOutcomeEffects = { notice: null, clearMap: false, discardCandidate: true };

export function runOutcomeEffects(outcome: RunOutcome, trigger: RunTrigger): RunOutcomeEffects {
  if (outcome.kind !== 'failed') return noEffects;
  switch (outcome.stage) {
    case 'generation':
    case 'map-test':
      return {
        notice: executionFailureNoticeContent(outcome, outcome.presentation),
        clearMap: true,
        discardCandidate: true,
      };
    case 'analysis':
    case 'request':
      return trigger === 'explicit'
        ? {
            notice: executionFailureNoticeContent(outcome, outcome.presentation),
            clearMap: false,
            discardCandidate: true,
          }
        : noEffects;
  }
}

export function failureReportedByMain(
  presentation: Pick<OutputMessage, 'code'>,
  run: 'preview' | 'map-test',
): boolean {
  return presentation.code.startsWith(
    run === 'map-test' ? 'source-catalog.batch.' : 'source-catalog.required.',
  );
}

export function runFailureSource(stage: RunFailureStage): OutputSource {
  return stage === 'map-test' ? 'Map test' : 'Run';
}

const analysisRefusal =
  /the script could not be analyzed|strict semantic analysis is unavailable/iu;

function stageFallbackHeadline(stage: RunFailureStage, message: string): MessageId {
  switch (stage) {
    case 'analysis':
      return analysisRefusal.test(message)
        ? 'run-menu.failure.not-analyzed'
        : 'run-menu.failure.not-checked';
    case 'request':
      return 'run-menu.failure.not-started';
    case 'map-test':
      return 'message.fallback.map-test';
    case 'generation':
      return 'run-menu.failure.generation';
  }
}

export function runFailureMessage(
  { stage, message }: { stage: RunFailureStage; message: string },
  context: Pick<MessageInput, 'locate' | 'standardIncludeAccess' | 'params'> = {},
): OutputMessage {
  return presentMessage({
    source: runFailureSource(stage),
    raw: message,
    ...(stage === 'map-test' && !messageCode(message) ? { code: 'map-test.execution' } : {}),
    fallbackHeadline: stageFallbackHeadline(stage, message),
    ...context,
  });
}

export function executionFailureNoticeContent(
  failure: { stage: RunFailureStage; message: string },
  presentation: OutputMessage = runFailureMessage(failure),
): ExecutionFailureNoticeContent {
  const action = presentation.action?.link ? undefined : presentation.action?.label;
  const translator = presentation.wording ? activeTranslator() : englishTranslator;
  const detail = [presentation.cause, action]
    .filter((part): part is string => Boolean(part))
    .map((part) => sentence(part, translator))
    .join(' ');
  return { title: presentation.headline, detail: detail ? shortened(detail) : null, presentation };
}

export function rewordExecutionFailureNotice(
  notice: ExecutionFailureNoticeContent,
): ExecutionFailureNoticeContent {
  if (!notice.presentation.wording) return notice;
  return executionFailureNoticeContent(
    { stage: 'generation', message: '' },
    rewordOutputMessage(notice.presentation),
  );
}

const detailLimit = 220;

function shortened(text: string): string {
  return text.length <= detailLimit ? text : `${text.slice(0, detailLimit - 1).trimEnd()}…`;
}

export function classifyMapTestRejection(message: string): RunOutcome {
  if (messageCode(message)?.startsWith('map-test.child-')) {
    return { kind: 'failed', stage: 'map-test', message };
  }
  if (/cancel|stopp/iu.test(message)) return { kind: 'cancelled' };
  if (/changed while execution/iu.test(message)) {
    return { kind: 'superseded', reason: 'source-changed' };
  }
  if (/already active/iu.test(message)) return { kind: 'superseded', reason: 'other-execution' };
  return { kind: 'failed', stage: 'map-test', message };
}
