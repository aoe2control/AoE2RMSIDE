import { SourceCatalogDiscoveryError } from './source-catalog-probes';

interface SourceExecutionEpochs {
  nativeEpoch(): string;
  sourceEpoch(): number;
}

export function captureSourceExecution(epochs: SourceExecutionEpochs) {
  const nativeEpoch = epochs.nativeEpoch();
  const sourceEpoch = epochs.sourceEpoch();
  const assertCurrent = (): void => {
    if (nativeEpoch !== epochs.nativeEpoch() || sourceEpoch !== epochs.sourceEpoch()) {
      throw new SourceCatalogDiscoveryError('stale', 'entry', 1, 0);
    }
  };
  return {
    assertCurrent,
    async run<T>(generate: () => Promise<T>, validate: (result: T) => Promise<void>): Promise<T> {
      assertCurrent();
      const result = await generate();
      assertCurrent();
      await validate(result);
      assertCurrent();
      return result;
    },
  };
}
