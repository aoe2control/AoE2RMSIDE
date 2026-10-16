export const codeSemanticTokenTypes = [
  'comment',
  'keyword',
  'namespace',
  'function',
  'property',
  'number',
  'string',
  'variable',
  'operator',
  'control',
] as const;

export type CodeSemanticTokenType = (typeof codeSemanticTokenTypes)[number];

export interface SemanticTokensModel {
  getVersionId(): number;
  isDisposed(): boolean;
}

export interface SemanticTokensResult {
  data?: readonly number[];
}

export function semanticTokensCancellation(): Error {
  const error = new Error('Canceled');
  error.name = 'Canceled';
  return error;
}

export function semanticTokensForVersion(
  model: SemanticTokensModel,
  requestedVersion: number,
  result: SemanticTokensResult | null,
): { data: Uint32Array } {
  if (result === null || model.isDisposed() || model.getVersionId() !== requestedVersion) {
    throw semanticTokensCancellation();
  }
  return { data: new Uint32Array(result.data ?? []) };
}

export const semanticTokensRetryDelays: readonly number[] = [250, 500, 1_000, 2_000, 4_000, 8_000];

export interface SemanticTokensRetry {
  answered(): void;
  missed(): void;
  answersChanged(): void;
}

export function createSemanticTokensRetry(
  askAgain: () => void,
  timers: {
    set(callback: () => void, delay: number): unknown;
    clear(handle: unknown): void;
  } = {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): SemanticTokensRetry {
  let unanswered = false;
  let retries = 0;
  let pending: unknown = null;
  return {
    answered() {
      unanswered = false;
      retries = 0;
      if (pending !== null) timers.clear(pending);
      pending = null;
    },
    missed() {
      unanswered = true;
      if (pending !== null) return;
      const delay = semanticTokensRetryDelays[retries];
      if (delay === undefined) return;
      retries += 1;
      pending = timers.set(() => {
        pending = null;
        askAgain();
      }, delay);
    },
    answersChanged() {
      if (unanswered && pending === null) askAgain();
    },
  };
}
