import type { PreviewGenerationResult } from '../shared/api';
import {
  type ConstructVerification,
  constructLabel,
  uncertifiedConstructCount,
  uncertifiedConstructList,
} from '../shared/construct-verification';
import { presentMessage } from '../shared/message-catalog';
import { type OutputMessage, type OutputText, sentence } from '../shared/output-message';
import type { OutputRunConstructs } from './output-log';

export function constructVerificationMessage(
  verification: ConstructVerification | undefined,
): OutputMessage | null {
  if (verification?.status !== 'uncertified-constructs') return null;
  return presentMessage({
    source: 'Run',
    code: 'preview.unchecked-constructs',
    params: {
      count: uncertifiedConstructCount(verification),
      constructs: uncertifiedConstructList(verification),
    },
  });
}

export function constructVerificationNote(
  verification: ConstructVerification | undefined,
): string | null {
  return constructVerificationMessage(verification)?.headline ?? null;
}

export function constructVerificationDescription(
  verification: ConstructVerification | undefined,
): string | null {
  const message = constructVerificationMessage(verification);
  if (!message) return null;
  return [sentence(message.headline), message.cause ? sentence(message.cause) : null]
    .filter(Boolean)
    .join(' ');
}

export function outputRunConstructs(
  result: Pick<
    PreviewGenerationResult,
    'backend' | 'constructVerification' | 'provenanceOperations'
  >,
): OutputRunConstructs | undefined {
  if (result.backend !== 'exact') return undefined;
  const verification = result.constructVerification;
  if (!verification || !constructVerificationNote(verification)) return undefined;
  const count = uncertifiedConstructCount(verification);
  const note: OutputText =
    Number.isSafeInteger(count) && count > 0
      ? { id: 'message.preview.unchecked-constructs.headline.count', args: { count } }
      : { id: 'message.preview.unchecked-constructs.headline' };
  const items = verification.uncertified.flatMap((construct) => {
    const operation = result.provenanceOperations[construct.firstOperationIndex];
    return operation ? [{ label: constructLabel(construct), operation }] : [];
  });
  return {
    note,
    items,
    omitted: uncertifiedConstructCount(verification) - items.length,
  };
}
