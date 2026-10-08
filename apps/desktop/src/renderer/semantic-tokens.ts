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
  if (model.isDisposed() || model.getVersionId() !== requestedVersion) {
    throw semanticTokensCancellation();
  }
  return { data: new Uint32Array(result?.data ?? []) };
}
