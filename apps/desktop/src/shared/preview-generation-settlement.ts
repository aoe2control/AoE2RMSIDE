import type { PreviewGenerationResult } from './api';
import { withValidatedConstructVerification } from './construct-verification';
import { parseExecutionCostSummary } from './execution-cost';

export interface PreviewGenerationCancellation {
  readonly kind: 'preview-generation-cancelled';
  readonly code: 'cancelled';
  readonly message: string;
}

export type PreviewGenerationSettlement =
  | { readonly status: 'completed'; readonly result: PreviewGenerationResult }
  | { readonly status: 'cancelled'; readonly cancellation: PreviewGenerationCancellation };

export const previewGenerationCancellationMessageLimit = 1024;

export function previewGenerationCancellation(message: string): PreviewGenerationCancellation {
  return Object.freeze({
    kind: 'preview-generation-cancelled',
    code: 'cancelled',
    message: message.slice(0, previewGenerationCancellationMessageLimit),
  });
}

export async function settlePreviewGeneration<TCancellation>(
  operation: Promise<PreviewGenerationResult>,
  isCancellation: (error: unknown) => error is TCancellation,
  cancellationMessage: (error: TCancellation) => string,
): Promise<PreviewGenerationSettlement> {
  try {
    return { status: 'completed', result: await operation };
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return {
      status: 'cancelled',
      cancellation: previewGenerationCancellation(cancellationMessage(error)),
    };
  }
}

export function assertPreviewGenerationSettlement(value: unknown): PreviewGenerationSettlement {
  if (!isPlainRecord(value)) throw new Error('preview generation settlement is invalid');
  const keys = Object.keys(value).sort();
  if (value.status === 'completed') {
    if (keys.join(',') !== 'result,status' || !isPlainRecord(value.result)) {
      throw new Error('preview generation settlement is invalid');
    }
    return { status: 'completed', result: value.result as unknown as PreviewGenerationResult };
  }
  if (value.status === 'cancelled') {
    if (
      keys.join(',') !== 'cancellation,status' ||
      !isPreviewGenerationCancellation(value.cancellation)
    ) {
      throw new Error('preview generation settlement is invalid');
    }
    return {
      status: 'cancelled',
      cancellation: previewGenerationCancellation(value.cancellation.message),
    };
  }
  throw new Error('preview generation settlement is invalid');
}

export function unwrapPreviewGenerationSettlement(value: unknown): PreviewGenerationResult {
  const settlement = assertPreviewGenerationSettlement(value);
  if (settlement.status === 'completed') {
    return withValidatedConstructVerification(withValidatedExecutionCost(settlement.result));
  }
  throw settlement.cancellation;
}

export function isPreviewGenerationCancellation(
  value: unknown,
): value is PreviewGenerationCancellation {
  return (
    isPlainRecord(value) &&
    Object.keys(value).sort().join(',') === 'code,kind,message' &&
    value.kind === 'preview-generation-cancelled' &&
    value.code === 'cancelled' &&
    typeof value.message === 'string' &&
    value.message.length <= previewGenerationCancellationMessageLimit
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function withValidatedExecutionCost<T extends { executionCost?: unknown }>(result: T): T {
  if (!result || typeof result !== 'object' || result.executionCost === undefined) return result;
  const executionCost = parseExecutionCostSummary(result.executionCost);
  if (executionCost) result.executionCost = executionCost;
  else delete result.executionCost;
  return result;
}
